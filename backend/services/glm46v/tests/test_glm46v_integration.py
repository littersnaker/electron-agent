from __future__ import annotations

import base64
from types import SimpleNamespace

import httpx
import pytest

from backend.services.glm46v.client import (
    GLM46VClient,
    GLM46VSettings,
    normalize_chat_endpoint,
    normalize_image_data,
)
from backend.services.glm46v.enrichment import enrich_runtime_context_with_glm46v
from backend.services.glm46v.skill import GLM46V_SKILL_ID
from backend.services.runtime.contracts import RuntimeContext, RuntimeRequest


class FakeCredentials:
    def __init__(self, key: str = "request-key", endpoint: str = "") -> None:
        self.key = key
        self.endpoint = endpoint

    def get(self, provider: str) -> str:
        return self.key if provider == "glm" else ""

    def get_endpoint(self, provider: str) -> str:
        return self.endpoint if provider == "glm" else ""


def tiny_png_base64() -> str:
    # 1x1 transparent PNG
    return base64.b64encode(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
    ).decode("ascii")


def test_normalize_endpoint() -> None:
    assert (
        normalize_chat_endpoint("https://open.bigmodel.cn/api/paas/v4")
        == "https://open.bigmodel.cn/api/paas/v4/chat/completions"
    )
    assert (
        normalize_chat_endpoint("https://example.com/v1/chat/completions/")
        == "https://example.com/v1/chat/completions"
    )


def test_settings_prefers_request_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ZHIPU_API_KEY", "env-key")
    settings = GLM46VSettings.from_credentials(
        FakeCredentials("request-key", "https://gateway.example/v4")
    )
    assert settings.api_key == "request-key"
    assert settings.endpoint == "https://gateway.example/v4/chat/completions"
    assert settings.model == "glm-4.6v-flash"


def test_image_normalization_accepts_data_url() -> None:
    value = f"data:image/png;base64,{tiny_png_base64()}"
    image = normalize_image_data(
        name="reference.png",
        mime_type="image/png",
        data=value,
        max_image_mb=1,
    )
    assert image.name == "reference.png"
    assert image.mime_type == "image/png"
    assert image.size_bytes > 0


@pytest.mark.asyncio
async def test_client_calls_glm_endpoint() -> None:
    seen: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        seen["authorization"] = request.headers.get("authorization")
        seen["json"] = __import__("json").loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "id": "req_test",
                "model": "glm-4.6v-flash",
                "choices": [
                    {
                        "message": {"content": "识别到一个测试图片。"},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
            },
        )

    settings = GLM46VSettings(
        api_key="secret",
        endpoint="https://example.test/chat/completions",
    )
    client = GLM46VClient(settings, transport=httpx.MockTransport(handler))
    image = normalize_image_data(
        name="reference.png",
        mime_type="image/png",
        data=tiny_png_base64(),
        max_image_mb=1,
    )
    result = await client.analyze_images([image], prompt="分析图片")
    assert result["content"] == "识别到一个测试图片。"
    assert seen["authorization"] == "Bearer secret"
    payload = seen["json"]
    assert isinstance(payload, dict)
    assert payload["model"] == "glm-4.6v-flash"
    assert payload["thinking"] == {"type": "enabled"}


class FakeClient:
    def __init__(self) -> None:
        self.settings = GLM46VSettings(
            api_key="fake",
            endpoint="https://example.test/chat/completions",
        )

    async def analyze_images(self, images, *, prompt: str, max_tokens: int = 6144):
        assert images
        assert "视觉证据分析子代理" in prompt
        return {
            "model": "glm-4.6v-flash",
            "content": "直接可见：页面顶部有导航栏。",
            "usage": {"total_tokens": 20},
        }


@pytest.mark.asyncio
async def test_enrichment_appends_visual_evidence() -> None:
    attachment = SimpleNamespace(
        name="ui.png",
        mime_type="image/png",
        data=tiny_png_base64(),
        data_url=None,
    )
    payload = SimpleNamespace(attachments=[attachment])
    request = RuntimeRequest(
        agent_id="coding",
        payload=payload,
        preferred_model_id="auto",
        credentials=FakeCredentials(),
        session_id="s1",
        project_id="p1",
        user_text="按图片还原页面",
    )
    context = RuntimeContext(
        rendered="## Skill · workspace-code-agent@1\n遵守工程约束。",
        token_budget=24_000,
        estimated_tokens=20,
        skill_ids=("workspace-code-agent",),
    )
    enriched = await enrich_runtime_context_with_glm46v(
        request=request,
        context=context,
        agent_id="coding",
        client=FakeClient(),  # type: ignore[arg-type]
    )
    assert "Skill Tool Result · glm46v-vision" in enriched.rendered
    assert "页面顶部有导航栏" in enriched.rendered
    assert GLM46V_SKILL_ID in enriched.skill_ids
    assert enriched.metadata["glm46vVision"]["used"] is True


def test_strip_image_attachments_keeps_non_images() -> None:
    from backend.schemas.chat import ChatRequest
    from backend.schemas.common import FrontendAttachment
    from backend.services.glm46v.enrichment import strip_image_attachments

    body = ChatRequest(
        attachments=[
            FrontendAttachment(
                name="screen.png",
                mimeType="image/png",
                data=tiny_png_base64(),
            ),
            FrontendAttachment(
                name="notes.txt",
                mimeType="text/plain",
                data="dGVzdA==",
            ),
        ]
    )
    stripped = strip_image_attachments(body)
    assert stripped is not body
    assert len(stripped.attachments) == 1
    assert stripped.attachments[0].name == "notes.txt"
    assert len(body.attachments) == 2


@pytest.mark.asyncio
async def test_strict_enrichment_fails_without_glm_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from backend.services.glm46v.client import GLM46VError

    monkeypatch.delenv("ZHIPU_API_KEY", raising=False)
    monkeypatch.delenv("GLM_API_KEY", raising=False)
    attachment = SimpleNamespace(
        name="ui.png",
        mime_type="image/png",
        data=tiny_png_base64(),
        data_url=None,
    )
    request = RuntimeRequest(
        agent_id="qa",
        payload=SimpleNamespace(attachments=[attachment]),
        preferred_model_id="deepseek-flash-0731",
        credentials=FakeCredentials(key=""),
        session_id="s1",
        project_id="p1",
        user_text="图里是什么",
    )
    context = RuntimeContext(rendered="", token_budget=24_000, estimated_tokens=0)
    with pytest.raises(GLM46VError, match="API Key"):
        await enrich_runtime_context_with_glm46v(
            request=request,
            context=context,
            agent_id="qa",
            strict=True,
        )
