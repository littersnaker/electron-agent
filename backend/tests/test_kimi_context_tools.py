"""Kimi 参数兼容、中文索引和只读工具循环回归测试。"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from backend.services.agent.loop.read_only_loop import stream_read_only_tool_answer
from backend.services.agent.shared.context import _fallback_overview_files
from backend.services.agent.shared.tool_registry import (
    public_tool_catalog,
    tool_names_for_mode,
)
from backend.services.agent.shared.workspace_tools import (
    render_workspace_tree,
    search_workspace,
)
from backend.services.llm.catalog import ModelDefinition, get_provider
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import LlmGateway
from backend.services.llm.protocols import LlmProtocolClient, ProviderRequestError
from backend.services.llm.types import LlmMessage, LlmUsage
from backend.services.workspace.indexer import _query_terms


def _kimi_model(name: str = "kimi-k2.6") -> ModelDefinition:
    """创建测试使用的 Kimi 模型定义。"""

    return ModelDefinition(
        id=f"custom:{name}",
        provider="kimi",
        model=name,
        name=name,
        description="test",
        capabilities=("text", "stream"),
        base_url="https://api.moonshot.cn/v1",
        is_custom=True,
    )


def test_chinese_query_is_split_into_searchable_terms() -> None:
    """验证中文整句不会再被当成一个永远无法命中的搜索词。"""

    terms = _query_terms("目前这个项目能承担到电商小程序的功能了么")

    assert "电商" in terms
    assert "小程序" in terms
    assert "程序" in terms



def test_direct_workspace_search_supports_chinese_sentence(tmp_path: Path) -> None:
    """验证 search 工具直接接收中文整句时也能命中项目内容。"""

    (tmp_path / "shop.ts").write_text("export const 电商小程序 = true\n", "utf-8")

    result = search_workspace(tmp_path, "目前这个项目能承担到电商小程序的功能了么")

    assert "shop.ts" in result
    assert "电商小程序" in result

def test_context_falls_back_to_project_overview_files(tmp_path: Path) -> None:
    """验证关键词无命中时仍会读取项目清单和入口文件。"""

    (tmp_path / "package.json").write_text('{"scripts":{"build":"vite build"}}', "utf-8")
    source = tmp_path / "src"
    source.mkdir()
    (source / "app.ts").write_text("export const app = true\n", "utf-8")
    (source / "random.xyz").write_text("ignored\n", "utf-8")

    files = _fallback_overview_files(tmp_path)
    paths = {str(item["path"]) for item in files}

    assert "package.json" in paths
    assert "src/app.ts" in paths


def test_tool_catalog_contains_read_and_write_tools() -> None:
    """验证工具目录集中注册，避免后续分支覆盖时静默丢失。"""

    names = {item["name"] for item in public_tool_catalog()}

    assert {"search", "read", "edit", "run", "complete_work", "finish"} <= names



def test_tool_catalog_matches_execution_mode(monkeypatch) -> None:
    """全自动必须暴露 edit/run；自动编辑在关闭审批门时禁用 run；只读模式不得暴露写入。"""

    assert "edit" in tool_names_for_mode(execution_mode="auto_edit")
    # 自动编辑模式默认暴露 run（供安装类命令走审批门）；关闭审批门后恢复禁用。
    assert "run" in tool_names_for_mode(execution_mode="auto_edit")
    monkeypatch.setenv("CODE_AGENT_COMMAND_APPROVAL", "0")
    assert "run" not in tool_names_for_mode(execution_mode="auto_edit")
    assert {"edit", "run"} <= set(
        tool_names_for_mode(execution_mode="full_auto")
    )
    assert set(tool_names_for_mode(read_only=True)) == {
        "search",
        "read",
        "inspect",
        "finish",
    }


def test_workspace_tree_hides_sensitive_files_but_keeps_template(tmp_path: Path) -> None:
    """目录树不向模型暴露真实环境文件，但保留可安全参考的模板。"""

    (tmp_path / ".env.development").write_text("SECRET=value", "utf-8")
    (tmp_path / ".env.example").write_text("API_URL=", "utf-8")
    (tmp_path / "src").mkdir()
    (tmp_path / "src/app.ts").write_text("export {};", "utf-8")

    tree = render_workspace_tree(tmp_path)

    assert ".env.development" not in tree
    assert ".env.example" in tree
    assert "src/app.ts" in tree

def test_kimi_k26_omits_temperature_and_keeps_full_endpoint() -> None:
    """验证 K2.6 不发送非法 temperature，并兼容 Base URL 与完整端点。"""

    gateway = LlmGateway()
    provider = get_provider("kimi")
    model = _kimi_model()

    assert gateway._request_temperature(provider, model, 0.1) is None
    assert (
        gateway._normalize_chat_endpoint("https://api.moonshot.cn/v1")
        == "https://api.moonshot.cn/v1/chat/completions"
    )
    assert (
        gateway._normalize_chat_endpoint(
            "https://api.moonshot.cn/v1/chat/completions"
        )
        == "https://api.moonshot.cn/v1/chat/completions"
    )


@pytest.mark.asyncio
async def test_openai_protocol_omits_none_temperature() -> None:
    """验证实际 HTTP JSON 中不会出现值为 None 的 temperature 字段。"""

    captured: dict[str, object] = {}

    async def handler(request: httpx.Request) -> httpx.Response:
        """记录请求并返回最小 SSE。"""

        captured.update(json.loads(request.content.decode("utf-8")))
        return httpx.Response(
            200,
            text=(
                'data: {"choices":[{"delta":{"content":"OK"}}]}\n\n'
                'data: {"choices":[],"usage":{"prompt_tokens":12,'
                '"completion_tokens":3,"total_tokens":15}}\n\n'
                "data: [DONE]\n\n"
            ),
            headers={"content-type": "text/event-stream"},
        )

    client = LlmProtocolClient()
    await client._client.aclose()
    await client._direct_client.aclose()
    # Kimi 属于国内直连供应商，测试必须替换直连客户端。
    client._direct_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    chunks = []
    usages: list[LlmUsage] = []
    async for chunk in client.stream_openai_compatible(
        model=_kimi_model(),
        endpoint="https://api.moonshot.cn/v1/chat/completions",
        api_key="test-key",
        messages=[LlmMessage("user", "你好")],
        temperature=None,
    ):
        chunks.append(chunk.text_delta)
        if chunk.usage:
            usages.append(chunk.usage)
    await client.close()

    assert "temperature" not in captured
    assert captured["stream_options"] == {"include_usage": True}
    assert "".join(chunks) == "OK"
    assert usages == [LlmUsage(prompt=12, completion=3, total=15)]


@pytest.mark.asyncio
async def test_read_only_agent_uses_search_and_read_before_answer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """验证只读问题不会在索引无命中时直接声称没有上下文。"""

    (tmp_path / "package.json").write_text('{"name":"shop-app"}', "utf-8")
    responses = iter(
        [
            {"action": "search", "query": "package.json app route"},
            {"action": "read", "paths": ["package.json"]},
            {"action": "finish", "answer": "结论：项目包含 package.json，可继续分析。"},
        ]
    )

    async def fake_complete(**_kwargs):
        """依次返回搜索、读取和完成动作。"""

        return (
            json.dumps(next(responses), ensure_ascii=False),
            LlmUsage(prompt=10, completion=5, total=15),
            SimpleNamespace(name="Fake Kimi"),
        )

    monkeypatch.setattr(
        "backend.services.agent.loop.read_only_loop.GATEWAY.complete",
        fake_complete,
    )
    frames: list[str] = []
    async for frame in stream_read_only_tool_answer(
        root=tmp_path,
        user_text="这个项目能做电商小程序吗",
        initial_context="（索引未命中）",
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
    ):
        frames.append(frame)

    output = "".join(frames)
    assert "search_codebase" in output
    assert "read_file_from_disk" in output
    assert "项目包含 package.json" in output


@pytest.mark.asyncio
async def test_connectivity_measures_headers_only_latency() -> None:
    """纯网络延迟只测量到响应头，不等待模型生成内容。"""

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            text="data: [DONE]\n\n",
            headers={"content-type": "text/event-stream"},
        )

    client = LlmProtocolClient()
    await client._client.aclose()
    await client._direct_client.aclose()
    client._direct_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    latency_ms = await client.measure_connectivity(
        model=_kimi_model(),
        endpoint="https://api.moonshot.cn/v1/chat/completions",
        api_key="test-key",
    )

    assert latency_ms >= 0
    await client.close()


@pytest.mark.asyncio
async def test_connectivity_reports_auth_failure() -> None:
    """401 鉴权错误必须抛出，不能显示为连接正常。"""

    async def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text='{"error":{"message":"bad key"}}')

    client = LlmProtocolClient()
    await client._client.aclose()
    await client._direct_client.aclose()
    client._direct_client = httpx.AsyncClient(transport=httpx.MockTransport(handler))

    with pytest.raises(ProviderRequestError):
        await client.measure_connectivity(
            model=_kimi_model(),
            endpoint="https://api.moonshot.cn/v1/chat/completions",
            api_key="bad-key",
        )
    await client.close()
