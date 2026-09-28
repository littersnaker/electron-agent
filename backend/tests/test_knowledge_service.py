"""知识库服务层测试：新格式入库、metadata 校验与扩展名白名单。"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient
from openpyxl import Workbook

from backend.core.config import get_settings
from backend.main import create_app


def _client(monkeypatch, tmp_path: Path) -> TestClient:
    """创建指向临时数据目录的测试客户端。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    return TestClient(create_app())


def test_default_extensions_include_new_formats(monkeypatch, tmp_path: Path) -> None:
    """默认扩展名白名单应包含 markdown/xlsx/csv。"""

    monkeypatch.delenv("KNOWLEDGE_DOC_EXTENSIONS", raising=False)
    get_settings.cache_clear()
    try:
        extensions = get_settings().knowledge_doc_extensions
    finally:
        get_settings.cache_clear()
    assert ".markdown" in extensions
    assert ".xlsx" in extensions
    assert ".csv" in extensions


def test_upload_markdown_csv_xlsx(monkeypatch, tmp_path: Path) -> None:
    """新格式都能登记入库；无 Key 时文件保存但索引失败。"""

    workbook = Workbook()
    workbook.active.append(["列A", "列B"])
    workbook.active.append(["a1", "b1"])
    import io

    buffer = io.BytesIO()
    workbook.save(buffer)
    xlsx_bytes = buffer.getvalue()

    with _client(monkeypatch, tmp_path) as client:
        for filename, content, mime in [
            ("notes.markdown", "# 笔记\n内容", "text/markdown"),
            (
                "table.csv",
                "城市,温度\n上海,28".encode("utf-8-sig"),
                "text/csv",
            ),
            (
                "sheet.xlsx",
                xlsx_bytes,
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            ),
        ]:
            response = client.post(
                "/api/knowledge/documents",
                files={"file": (filename, content, mime)},
            )
            assert response.status_code == 200, filename
            payload = response.json()
            assert payload["document"]["filename"] == filename
            # 上传异步化：立即返回排队标记，状态停留 pending。
            assert payload["indexQueued"] is True
            assert payload["document"]["status"] == "pending"

        listing = client.get("/api/knowledge/documents").json()["documents"]
        assert {item["filename"] for item in listing} == {
            "notes.markdown",
            "table.csv",
            "sheet.xlsx",
        }


def test_upload_rejects_invalid_metadata(monkeypatch, tmp_path: Path) -> None:
    """metadata 必须是 JSON 对象，否则 400。"""

    with _client(monkeypatch, tmp_path) as client:
        broken_json = client.post(
            "/api/knowledge/documents",
            files={"file": ("a.md", "内容".encode(), "text/markdown")},
            data={"metadata": "{not-json"},
        )
        assert broken_json.status_code == 400

        not_object = client.post(
            "/api/knowledge/documents",
            files={"file": ("a.md", "内容".encode(), "text/markdown")},
            data={"metadata": "[1, 2, 3]"},
        )
        assert not_object.status_code == 400
        assert "JSON 对象" in not_object.json()["error"]


def test_upload_accepts_metadata_object(monkeypatch, tmp_path: Path) -> None:
    """合法 metadata 对象应随文档保存。"""

    with _client(monkeypatch, tmp_path) as client:
        response = client.post(
            "/api/knowledge/documents",
            files={"file": ("a.md", "# 内容".encode(), "text/markdown")},
            data={"metadata": '{"source": "test"}'},
        )
        assert response.status_code == 200
        assert response.json()["document"]["metadata"] == {"source": "test"}


def test_jina_key_persisted_and_status_reflects(monkeypatch, tmp_path: Path) -> None:
    """Key 持久化后：status.hasApiKey 变 true（无请求头也生效），且不回传原文。"""

    with _client(monkeypatch, tmp_path) as client:
        # 无 Key 时状态为 false。
        assert client.get("/api/knowledge/status").json()["hasApiKey"] is False

        saved = client.post(
            "/api/knowledge/key",
            json={"apiKey": "jina_test_key_123"},
        )
        assert saved.status_code == 200
        assert saved.json() == {"hasKey": True}

        status = client.get("/api/knowledge/status").json()
        assert status["hasApiKey"] is True
        assert "jina_test_key_123" not in json.dumps(status)

        # 清空：hasApiKey 回到 false。
        cleared = client.post("/api/knowledge/key", json={"apiKey": ""})
        assert cleared.json() == {"hasKey": False}
        assert client.get("/api/knowledge/status").json()["hasApiKey"] is False


def test_persisted_key_falls_back_for_index(monkeypatch, tmp_path: Path) -> None:
    """持久化 Key 后上传不再带请求头也能进入索引（background 任务拉起）。"""

    import json as json_module

    with _client(monkeypatch, tmp_path) as client:
        client.post("/api/knowledge/key", json={"apiKey": "jina_fallback_key"})
        upload = client.post(
            "/api/knowledge/documents",
            files={"file": ("a.md", "# 内容", "text/markdown")},
        )
        assert upload.status_code == 200
        # 后台任务异步执行：这里只验证接口不再要求请求头即可排队。
        assert upload.json()["indexQueued"] is True
        assert json_module is not None
