"""Kimi 参数兼容、中文索引和只读工具循环回归测试。"""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

from backend.services.agent.context import _fallback_overview_files
from backend.services.agent.read_only_loop import stream_read_only_tool_answer
from backend.services.agent.tool_registry import public_tool_catalog
from backend.services.agent.workspace_tools import search_workspace
from backend.services.llm.catalog import ModelDefinition, get_provider
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import LlmGateway
from backend.services.llm.protocols import LlmProtocolClient
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
            text='data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
            headers={"content-type": "text/event-stream"},
        )

    client = LlmProtocolClient()
    await client._client.aclose()
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    chunks = []
    async for chunk in client.stream_openai_compatible(
        model=_kimi_model(),
        endpoint="https://api.moonshot.cn/v1/chat/completions",
        api_key="test-key",
        messages=[LlmMessage("user", "你好")],
        temperature=None,
    ):
        chunks.append(chunk.text_delta)
    await client.close()

    assert "temperature" not in captured
    assert "".join(chunks) == "OK"


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
        "backend.services.agent.read_only_loop.GATEWAY.complete",
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
