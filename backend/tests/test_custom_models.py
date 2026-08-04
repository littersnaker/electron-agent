"""自定义模型 SQLite 持久化和媒体 Base URL 测试。"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from fastapi.testclient import TestClient

from backend.core.config import get_settings
from backend.main import app
from backend.services.llm import custom_models as custom_model_store
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.custom_models import get_custom_model_definition
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage
from backend.services.media.dashscope import resolve_media_api_base


def test_custom_model_crud_and_router(tmp_path: Path, monkeypatch) -> None:
    """验证自定义模型写入 SQLite 后可立即手动选择并参与 Auto。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("FRONTEND_DIR", raising=False)
    get_settings.cache_clear()

    payload = {
        "name": "我的百炼模型",
        "provider": "qwen",
        "model": "keep-this-model-value",
        "baseUrl": "https://workspace.example.test/compatible-mode/v1",
        "includeInAuto": True,
        "autoPriority": 1,
        "supportsVision": False,
    }
    with TestClient(app) as client:
        created_response = client.post("/api/models/custom", json=payload)
        assert created_response.status_code == 201
        created = created_response.json()["model"]
        model_id = created["id"]
        assert created["model"] == "keep-this-model-value"

    # 直接检查磁盘数据库，避免只验证到内存缓存。
    with sqlite3.connect(get_settings().database_path) as connection:
        stored = connection.execute(
            "SELECT model, base_url FROM custom_models WHERE id = ?",
            (model_id,),
        ).fetchone()
    assert stored == ("keep-this-model-value", payload["baseUrl"])

    # 模拟 Python 进程重启：清空内存后再次进入 lifespan，必须从 SQLite 恢复。
    custom_model_store._CACHE.clear()  # noqa: SLF001 - 仅测试重启恢复。
    with TestClient(app) as restarted_client:
        listed = restarted_client.get("/api/models/custom").json()["models"]
        assert [item["id"] for item in listed] == [model_id]

        definition = get_custom_model_definition(model_id)
        assert definition is not None
        assert definition.model == "keep-this-model-value"
        assert definition.base_url == payload["baseUrl"]

        credentials = LlmCredentials({"qwen": "test-key"})
        manual = GATEWAY.resolve_candidates(
            model_id,
            credentials,
            [LlmMessage("user", "hello")],
        )
        assert manual[0].model == "keep-this-model-value"
        automatic = GATEWAY.resolve_candidates(
            "auto",
            credentials,
            [LlmMessage("user", "hello")],
        )
        assert automatic[0].id == model_id

        deleted = restarted_client.delete(f"/api/models/custom/{model_id}")
        assert deleted.status_code == 204
        assert restarted_client.get("/api/models/custom").json()["models"] == []


def test_media_base_url_accepts_chat_or_full_endpoint(monkeypatch) -> None:
    """验证设置页聊天 Base URL 同时能驱动图片和视频原生接口。"""

    monkeypatch.setenv(
        "DASHSCOPE_BASE_URL",
        "https://workspace.example.test/compatible-mode/v1",
    )
    assert resolve_media_api_base() == "https://workspace.example.test"
    assert resolve_media_api_base(
        "https://another.example.test/api/v1/services/aigc/video-generation/video-synthesis"
    ) == "https://another.example.test"


def test_media_route_forwards_settings_base_url(
    tmp_path: Path,
    monkeypatch,
) -> None:
    """验证设置页请求头会传入图片和视频统一的媒体调用链。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    captured: dict[str, str | None] = {}

    async def fake_generate_media(
        _body,
        api_key: str,
        explicit_base_url: str | None = None,
    ) -> dict[str, object]:
        """记录路由转发值，避免测试真正访问外部模型接口。"""

        captured["api_key"] = api_key
        captured["base_url"] = explicit_base_url
        return {"content": "ok", "attachments": []}

    monkeypatch.setattr("backend.api.media.generate_media", fake_generate_media)
    with TestClient(app) as client:
        response = client.post(
            "/api/media/generate",
            headers={
                "x-llm-key-qwen": "test-key",
                "x-llm-base-url-qwen": (
                    "https://workspace.example.test/compatible-mode/v1"
                ),
            },
            json={
                "modelId": "qwen:qwen-image-2.0",
                "mode": "text-to-image",
                "prompt": "test",
            },
        )
    assert response.status_code == 200
    assert captured == {
        "api_key": "test-key",
        "base_url": "https://workspace.example.test/compatible-mode/v1",
    }
