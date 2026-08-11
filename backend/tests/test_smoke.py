"""FastAPI 迁移版核心功能冒烟测试。"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi import Request
from fastapi.testclient import TestClient

from backend.api.models import ModelProbeRequest, _resolve_probe_models
from backend.core.config import get_settings
from backend.main import app
from backend.schemas.chat import ChatRequest
from backend.services.agent.planner.classifier import (
    classify_request,
    resolve_effective_code_request,
)
from backend.services.agent.planner.request_routing import route_code_request
from backend.services.commerce.analytics import calculate_metrics, resolve_category
from backend.services.llm import credentials as credentials_module
from backend.services.llm.availability import AVAILABILITY
from backend.services.llm.catalog import get_model, get_provider
from backend.services.llm.credentials import LlmCredentials, resolve_credentials
from backend.services.llm.gateway import GATEWAY, LlmGateway
from backend.services.llm.protocols import ProviderRequestError
from backend.services.llm.types import ImagePart, LlmChunk, LlmMessage


def _read_sse_packets(raw_text: str) -> list[dict[str, object]]:
    """把测试响应中的 SSE ``data:`` 行解析成字典列表。"""

    packets: list[dict[str, object]] = []
    for line in raw_text.splitlines():
        if line.startswith("data:"):
            packets.append(json.loads(line[5:].strip()))
    return packets


def _request_with_headers(headers: list[tuple[bytes, bytes]]) -> Request:
    """创建只包含指定请求头的最小 FastAPI Request。"""

    return Request({"type": "http", "headers": headers})


def test_request_classifier() -> None:
    """验证 Code Agent 能区分只读问题、开发任务和省略式继续指令。"""

    assert classify_request("解释一下这个项目的入口") == "read_only"
    assert classify_request("请修改 main.py 并增加日志") == "code_change"
    assert classify_request("把这个项目做成电商小程序") == "code_change"
    assert (
        classify_request(
            "这次帮我把活干完",
            agent_mode="full_auto",
            conversation_text="把这个项目做成电商小程序\n这次帮我把活干完",
        )
        == "code_change"
    )
    assert (
        classify_request(
            "先只分析失败原因，不要修改",
            agent_mode="full_auto",
            conversation_text="请修改购物车页面",
        )
        == "read_only"
    )
    assert (
        classify_request(
            "为什么这个 Work 会失败",
            agent_mode="full_auto",
            conversation_text="请修改购物车页面",
        )
        == "read_only"
    )
    assert (
        classify_request(
            "敏感配置一直报错，别再读它，继续处理",
            agent_mode="full_auto",
            conversation_text="把这个项目做成电商小程序",
        )
        == "code_change"
    )


def test_effective_request_restores_previous_code_goal() -> None:
    """验证“继续做完”会补回最近代码目标，而不是只把短追问交给 Planner。"""

    result = resolve_effective_code_request(
        "不要只分析，继续把活干完",
        ["把这个项目做成电商小程序", "不要只分析，继续把活干完"],
    )

    assert "把这个项目做成电商小程序" in result
    assert "本轮补充要求" in result



def test_full_auto_follow_up_keeps_write_and_run_tools() -> None:
    """验证自动任务的报错追问不会误入只读 Agent。"""

    body = ChatRequest.model_validate(
        {
            "messages": [
                {"role": "user", "content": "把这个项目做成电商小程序"},
                {"role": "assistant", "content": "正在执行"},
                {
                    "role": "user",
                    "content": "敏感配置一直报错，别再读它，继续处理",
                },
            ],
            "agentMode": "full_auto",
        }
    )

    routed = route_code_request(body, body.messages[-1].content)

    assert routed.mode == "code_change"
    assert {"edit", "run"} <= set(routed.tool_names)
    assert "把这个项目做成电商小程序" in routed.effective_text

def test_commerce_analytics_is_deterministic() -> None:
    """验证市场指标使用确定性代码计算，而不是随机模型输出。"""

    category = resolve_category("portable espresso maker for camping")
    observations = [
        {
            "price": 29.9,
            "reviewCount": 120,
            "rating": 4.5,
            "domain": "example.com",
            "resultType": "shopping",
        },
        {
            "price": 39.9,
            "reviewCount": 80,
            "rating": 4.2,
            "domain": "shop.example",
            "resultType": "shopping",
        },
    ]
    first = calculate_metrics(observations, [], "USD")
    second = calculate_metrics(observations, [], "USD")
    assert category["keywords"]
    assert first == second
    assert first["medianPrice"] == 34.9


def test_fastapi_workspace_and_commerce(tmp_path: Path, monkeypatch) -> None:
    """验证健康检查、工作区、索引和 Commerce SSE 的完整最短路径。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("FRONTEND_DIR", raising=False)
    # 设置为空字符串可阻止 dotenv 再次从 .env.local 恢复真实密钥，
    # 从而保证冒烟测试完全离线、稳定且不会产生外部 API 费用。
    monkeypatch.setenv("TALORDATA_API_TOKEN", "")
    monkeypatch.setenv("SERPAPI_API_KEY", "")
    # 禁用 Amazon 公开爬虫，保证“无数据源 → Demo 兜底”的断言不依赖外部网络。
    monkeypatch.setenv("COMMERCE_AMAZON_CRAWLER", "0")
    get_settings.cache_clear()
    project_root = tmp_path / "demo-project"
    project_root.mkdir()
    (project_root / "hello.py").write_text("def hello():\n    return 'world'\n", "utf-8")

    with TestClient(app) as client:
        live = client.get("/api/health/live")
        assert live.status_code == 200
        assert live.json() == {
            "ok": True,
            "service": "multi-agent-fastapi",
        }

        health = client.get("/api/health")
        assert health.status_code == 200
        assert health.json()["ok"] is True
        assert health.json()["version"] == 3
        assert health.json()["runtime"] == "source"
        assert health.json()["sourceRoot"] == str(Path(__file__).resolve().parents[2])
        assert "no-store" in health.headers["cache-control"]

        initial_theme = client.get("/api/preferences/theme")
        assert initial_theme.status_code == 200
        assert initial_theme.json()["theme"] is None

        saved_theme = client.put(
            "/api/preferences/theme", json={"theme": "dark"}
        )
        assert saved_theme.status_code == 200
        assert saved_theme.json()["theme"] == "dark"
        assert client.get("/api/preferences/theme").json()["theme"] == "dark"

        created = client.post(
            "/api/workspace",
            json={"action": "createProject", "rootPath": str(project_root)},
        )
        assert created.status_code == 200
        project_id = created.json()["project"]["id"]

        indexed = client.post(f"/api/projects/{project_id}/index")
        assert indexed.status_code == 200
        assert indexed.json()["indexedFileCount"] == 1

        mcp_status = client.get("/api/mcp/status", params={"projectId": project_id})
        assert mcp_status.status_code == 200
        assert mcp_status.json()["projectId"] == project_id

        blocked_download = client.get(
            "/api/media/download",
            params={"url": "http://127.0.0.1:9999/private"},
        )
        assert blocked_download.status_code == 400

        listing = client.post(
            "/api/commerce/listing",
            json={"query": "compact travel kettle", "marketplace": "US"},
        )
        listing_packets = _read_sse_packets(listing.text)
        assert any(packet.get("type") == "COMMERCE_LISTING" for packet in listing_packets)

        research = client.post(
            "/api/commerce/research",
            json={"query": "compact travel kettle", "marketplace": "US"},
        )
        research_packets = _read_sse_packets(research.text)
        report_packet = next(
            packet for packet in research_packets if packet.get("type") == "COMMERCE_REPORT"
        )
        assert report_packet["payload"]["runMode"] == "demo"  # type: ignore[index]


def test_model_catalog_migrates_legacy_ids() -> None:
    """验证旧版 Kimi/千问选择值仍能映射到正确厂商模型。"""

    assert get_model("kimi:kimi-k2.5").id == "kimi:kimi-k3"  # type: ignore[union-attr]
    assert get_model("Qwen 3.7 Max Preview").model == (  # type: ignore[union-attr]
        "qwen3.7-max-2026-06-08"
    )


def test_manual_model_never_silently_changes_provider() -> None:
    """验证手动选择缺少 Key 时直接报错，而不是偷换成其他供应商。"""

    credentials = LlmCredentials({"qwen": "test-qwen-key"})
    try:
        GATEWAY.resolve_candidates(
            "kimi:kimi-k3",
            credentials,
            [LlmMessage("user", "hello")],
        )
    except ValueError as exc:
        assert "Kimi / Moonshot API Key" in str(exc)
    else:
        raise AssertionError("手动选择 Kimi 时不应回退到 Qwen")


def test_auto_router_builds_real_fallback_chain() -> None:
    """验证 Auto 包含首选与后备模型，并保持明确的降级顺序。"""

    AVAILABILITY.clear()
    credentials = LlmCredentials(
        {"qwen": "test-qwen-key", "kimi": "test-kimi-key"}
    )
    candidates = GATEWAY.resolve_candidates(
        "auto",
        credentials,
        [LlmMessage("user", "hello")],
    )
    candidate_ids = [model.id for model in candidates]
    assert candidate_ids[:3] == [
        "qwen:qwen3.7-max",
        "qwen:qwen3.7-plus",
        "qwen:qwen3.7-flash",
    ]
    assert "qwen:glm-5.2" in candidate_ids
    assert "qwen:kimi-k2.7-code" in candidate_ids
    assert "qwen:deepseek-v4-pro" in candidate_ids
    assert "kimi:kimi-k3" in candidate_ids
    assert all(model.auto_select or model.fallback_select for model in candidates)


def test_auto_router_requires_vision_for_image_input() -> None:
    """验证带图片的请求不会被发送到纯文本默认模型。"""

    AVAILABILITY.clear()
    credentials = LlmCredentials(
        {"qwen": "test-qwen-key", "kimi": "test-kimi-key"}
    )
    message = LlmMessage(
        "user",
        "describe",
        images=[ImagePart("image/png", "AA==")],
    )
    candidates = GATEWAY.resolve_candidates("auto", credentials, [message])
    assert candidates
    assert all("vision" in model.capabilities for model in candidates)
    assert candidates[0].id == "qwen:qwen3.7-plus"


def test_recent_successful_model_is_prioritized() -> None:
    """验证首次发现可用模型后，后续 Auto 请求会优先复用该模型。"""

    AVAILABILITY.clear()
    credentials = LlmCredentials({"qwen": "test-qwen-key"})
    initial = GATEWAY.resolve_candidates(
        "auto",
        credentials,
        [LlmMessage("user", "hello")],
    )
    flash = next(model for model in initial if model.id == "qwen:qwen3.7-flash")
    AVAILABILITY.mark_success(flash, credentials)
    reordered = GATEWAY.resolve_candidates(
        "auto",
        credentials,
        [LlmMessage("user", "hello again")],
    )
    assert reordered[0].id == "qwen:qwen3.7-flash"


def test_provider_probe_can_fallback_to_another_model() -> None:
    """验证供应商级连接测试会尝试多个通用模型而非只认第一个。"""

    candidates = _resolve_probe_models(ModelProbeRequest(provider="kimi"))
    assert [model.id for model in candidates] == [
        "kimi:kimi-k3",
        "kimi:kimi-k2.6",
    ]


def test_provider_endpoint_environment_override(monkeypatch) -> None:
    """验证企业或工作空间 Base URL 能覆盖公共区域端点。"""

    monkeypatch.setenv(
        "DASHSCOPE_BASE_URL",
        "https://workspace.example.test/compatible-mode/v1/",
    )
    endpoints = GATEWAY._provider_endpoints(get_provider("qwen"))
    assert endpoints == (
        "https://workspace.example.test/compatible-mode/v1/chat/completions",
    )


def test_invalid_base_url_override_is_ignored(monkeypatch) -> None:
    """把 API Key 填进 Base URL 环境变量时应回退默认端点，而不是拼出非法 URL。"""

    monkeypatch.setenv("DASHSCOPE_BASE_URL", "sk-invalid-key-value")
    endpoints = GATEWAY._provider_endpoints(get_provider("qwen"))

    assert endpoints
    assert all(endpoint.startswith("https://") for endpoint in endpoints)


def test_invalid_request_base_url_is_ignored() -> None:
    """请求头出现非 http(s) 的 Base URL 时应忽略并回退默认端点。"""

    request = _request_with_headers(
        [(b"x-llm-base-url-qwen", b"sk-invalid-key-value")]
    )
    credentials = resolve_credentials(request)

    assert credentials.get_endpoint("qwen") is None


def test_builtin_qwen_is_used_when_user_does_not_configure(monkeypatch) -> None:
    """验证用户未填写 Key 时，Python 后端会提供百炼内置兜底。"""

    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    monkeypatch.setattr(
        credentials_module,
        "get_builtin_value",
        lambda variable_name: (
            "builtin-qwen-key" if variable_name == "DASHSCOPE_API_KEY" else ""
        ),
    )
    credentials = resolve_credentials(_request_with_headers([]))
    assert credentials.get("qwen") == "builtin-qwen-key"
    assert credentials.source("qwen") == "builtin"


def test_user_qwen_key_overrides_builtin_fallback(monkeypatch) -> None:
    """验证用户自行配置的百炼 Key 始终优先于共享兜底。"""

    monkeypatch.delenv("DASHSCOPE_API_KEY", raising=False)
    monkeypatch.setattr(
        credentials_module,
        "get_builtin_value",
        lambda variable_name: (
            "builtin-qwen-key" if variable_name == "DASHSCOPE_API_KEY" else ""
        ),
    )
    request = _request_with_headers(
        [(b"x-llm-key-qwen", b"user-qwen-key")]
    )
    credentials = resolve_credentials(request)
    assert credentials.get("qwen") == "user-qwen-key"
    assert credentials.source("qwen") == "user"


def test_request_base_url_overrides_environment(monkeypatch) -> None:
    """验证设置页填写的百炼业务空间 Host 优先于打包环境地址。"""

    monkeypatch.setenv(
        "DASHSCOPE_BASE_URL",
        "https://environment.example.test/compatible-mode/v1",
    )
    request = _request_with_headers(
        [
            (
                b"x-llm-base-url-qwen",
                b"https://workspace.example.test/compatible-mode/v1",
            )
        ]
    )
    credentials = resolve_credentials(request)
    endpoints = GATEWAY._provider_endpoints(
        get_provider("qwen"),
        credentials.get_endpoint("qwen"),
    )
    assert endpoints == (
        "https://workspace.example.test/compatible-mode/v1/chat/completions",
    )


async def _collect_completion(gateway: LlmGateway, credentials: LlmCredentials):
    """执行最小 Auto completion，供路由降级测试复用。"""

    return await gateway.complete(
        preferred_model_id="auto",
        credentials=credentials,
        messages=[LlmMessage("user", "hello")],
    )


def test_model_level_error_falls_back_within_qwen(monkeypatch) -> None:
    """验证 Max 不存在时会继续使用同一百炼 Key 的 Plus。"""

    import asyncio

    AVAILABILITY.clear()
    gateway = LlmGateway()
    attempted: list[str] = []

    async def fake_stream_model(**kwargs):
        """模拟 Max 模型级失败，随后让 Plus 返回成功结果。"""

        model = kwargs["model"]
        attempted.append(model.id)
        if model.id == "qwen:qwen3.7-max":
            raise ProviderRequestError(
                "HTTP 404：模型未开通",
                status_code=404,
                scope="model",
            )
        yield LlmChunk(text_delta="PLUS_OK")

    monkeypatch.setattr(gateway, "_stream_model", fake_stream_model)
    text, _usage, model = asyncio.run(
        _collect_completion(gateway, LlmCredentials({"qwen": "test-key"}))
    )
    assert text == "PLUS_OK"
    assert model.id == "qwen:qwen3.7-plus"
    assert attempted[:2] == ["qwen:qwen3.7-max", "qwen:qwen3.7-plus"]


def test_provider_network_error_skips_redundant_qwen_models(monkeypatch) -> None:
    """验证端点断网后不会重复请求 Plus/Flash，而是切到其他供应商。"""

    import asyncio

    AVAILABILITY.clear()
    gateway = LlmGateway()
    attempted: list[str] = []

    async def fake_stream_model(**kwargs):
        """模拟百炼端点断网，并让其他供应商返回成功结果。"""

        model = kwargs["model"]
        attempted.append(model.id)
        if model.provider == "qwen":
            raise ProviderRequestError(
                "无法连接百炼接口",
                scope="provider",
            )
        yield LlmChunk(text_delta="KIMI_OK")

    monkeypatch.setattr(gateway, "_stream_model", fake_stream_model)
    text, _usage, model = asyncio.run(
        _collect_completion(
            gateway,
            LlmCredentials({"qwen": "qwen-key", "kimi": "kimi-key"}),
        )
    )
    assert text == "KIMI_OK"
    assert model.provider == "kimi"
    assert attempted[0] == "qwen:qwen3.7-max"
    assert "qwen:qwen3.7-plus" not in attempted
    assert "qwen:qwen3.7-flash" not in attempted
