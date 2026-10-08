"""OpenRouter 注册、凭证解析及真实协议路径的离线验证。"""

import json

import httpx
import pytest
from starlette.requests import Request

from backend.api.models import ModelProbeRequest, _resolve_probe_models
from backend.schemas.custom_models import CustomModelInput
from backend.services.llm.catalog import get_model
from backend.services.llm.credentials import resolve_credentials
from backend.services.llm.gateway import LlmGateway
from backend.services.llm.protocols import LlmProtocolClient
from backend.services.llm.types import LlmMessage


def test_openrouter_credentials_probe_and_custom_model(monkeypatch) -> None:
    """环境变量与用户设置均可解析，支持连接验证和自定义厂商/模型 ID。"""
    monkeypatch.setenv("OPENROUTER_API_KEY", "environment-key")
    request = Request({"type": "http", "headers": []})
    assert resolve_credentials(request).get("openrouter") == "environment-key"
    request = Request(
        {
            "type": "http",
            "headers": [
                (b"x-llm-key-openrouter", b"user-key"),
                (b"x-llm-base-url-openrouter", b"https://router.example/v1"),
            ],
        }
    )
    credentials = resolve_credentials(request)
    assert credentials.get("openrouter") == "user-key"
    assert credentials.source("openrouter") == "user"
    assert credentials.get_endpoint("openrouter") == "https://router.example/v1"
    assert (
        _resolve_probe_models(ModelProbeRequest(provider="openrouter"))[0].provider == "openrouter"
    )
    assert (
        CustomModelInput(name="Router", provider="openrouter", model="vendor/model").provider
        == "openrouter"
    )


@pytest.mark.asyncio
async def test_openrouter_gateway_uses_correct_endpoint_model_and_auth(monkeypatch) -> None:
    """通过网关和 HTTP MockTransport 验证默认地址、模型名、Bearer 鉴权与流式解析。"""
    monkeypatch.delenv("OPENROUTER_BASE_URL", raising=False)
    seen = []

    def respond(request):
        seen.append(request)
        data = {"choices": [{"delta": {"content": "OK"}}]}
        return httpx.Response(200, text=f"data: {json.dumps(data)}\n\ndata: [DONE]\n\n")

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        protocol = LlmProtocolClient.__new__(LlmProtocolClient)
        protocol._client = client
        protocol._direct_client = None  # 海外供应商必须沿用可读取代理配置的客户端。
        gateway = LlmGateway.__new__(LlmGateway)
        gateway._protocols = protocol
        model = get_model("openrouter:openai/gpt-4o-mini")
        from backend.services.llm.credentials import LlmCredentials

        chunks = [
            chunk
            async for chunk in gateway._stream_model(
                model=model,
                credentials=LlmCredentials({"openrouter": "test-key"}),
                messages=[LlmMessage("user", "hello")],
                temperature=0,
            )
        ]
    assert "".join(chunk.text_delta for chunk in chunks) == "OK"
    assert str(seen[0].url) == "https://openrouter.ai/api/v1/chat/completions"
    assert seen[0].headers["Authorization"] == "Bearer test-key"
    assert json.loads(seen[0].content)["model"] == "openai/gpt-4o-mini"
