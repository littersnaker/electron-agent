"""知识库上传管理接口测试。"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend.core.config import get_settings
from backend.main import create_app
from backend.services.workspace.database import initialize_database


def _client(monkeypatch, tmp_path: Path) -> TestClient:
    """创建指向临时数据目录的测试客户端。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    return TestClient(create_app())


def test_upload_rejects_unsupported_extension(
    monkeypatch, tmp_path: Path
) -> None:
    """不支持的文件类型应返回 400。"""

    with _client(monkeypatch, tmp_path) as client:
        response = client.post(
            "/api/knowledge/documents",
            files={"file": ("evil.exe", b"binary", "application/octet-stream")},
        )
    assert response.status_code == 400
    assert "不支持" in response.json()["error"]


def test_upload_list_delete_flow(monkeypatch, tmp_path: Path) -> None:
    """上传文档后应出现在列表，删除后应消失。"""

    with _client(monkeypatch, tmp_path) as client:
        upload = client.post(
            "/api/knowledge/documents",
            files={"file": ("guide.md", "# 使用指南\n欢迎使用。", "text/markdown")},
        )
        assert upload.status_code == 200
        document = upload.json()["document"]
        assert document["filename"] == "guide.md"
        # 未配置 Jina Key 时索引失败但文件已登记。
        assert upload.json()["index"]["ok"] is False

        listing = client.get("/api/knowledge/documents")
        assert listing.status_code == 200
        documents = listing.json()["documents"]
        assert any(item["id"] == document["id"] for item in documents)

        deleted = client.delete(f"/api/knowledge/documents/{document['id']}")
        assert deleted.status_code == 200

        listing_after = client.get("/api/knowledge/documents")
        documents_after = listing_after.json()["documents"]
        assert all(item["id"] != document["id"] for item in documents_after)


def test_delete_missing_document_returns_404(monkeypatch, tmp_path: Path) -> None:
    """删除不存在的文档应返回 404。"""

    with _client(monkeypatch, tmp_path) as client:
        response = client.delete("/api/knowledge/documents/not-exist")
    assert response.status_code == 404


def test_status_exposes_config_without_key(monkeypatch, tmp_path: Path) -> None:
    """状态接口应返回配置与用量，但不包含密钥。"""

    with _client(monkeypatch, tmp_path) as client:
        response = client.get("/api/knowledge/status")
        assert response.status_code == 200
        payload = response.json()
        assert "apiKey" not in payload
        assert payload["enabled"] is True
        assert payload["hasApiKey"] is False
        assert payload["embeddingModel"]
        assert payload["topK"] >= 1
