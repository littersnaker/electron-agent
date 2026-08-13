"""原生 Function Calling 接入测试：工具 Schema 生成与协议解析。"""

from __future__ import annotations

import json

import pytest

from backend.services.agent.shared.tool_registry import build_openai_tools
from backend.services.llm.protocols import LlmProtocolClient
from backend.services.llm.types import LlmMessage, LlmToolCall


async def _iter_chunks(chunks: list[LlmToolCall]):
    """把 tool_call 分片包装成网关可消费的 chunk 序列。"""

    from backend.services.llm.types import LlmChunk

    for call in chunks:
        yield LlmChunk(tool_calls=[call])


def test_build_openai_tools_covers_auto_edit_actions(monkeypatch) -> None:
    """auto_edit 模式默认（命令审批门开启）暴露 run；关闭时不含 run。"""

    monkeypatch.delenv("CODE_AGENT_COMMAND_APPROVAL", raising=False)

    tools = build_openai_tools(execution_mode="auto_edit")
    names = {tool["function"]["name"] for tool in tools}

    assert {"search", "read", "edit", "complete_work", "finish"} <= names
    # 命令审批门默认开启：auto_edit 也暴露 run（安装/初始化命令会弹审批确认）。
    assert "run" in names
    # 每个工具都带函数参数 Schema。
    for tool in tools:
        assert tool["type"] == "function"
        assert "parameters" in tool["function"]
        assert tool["function"]["parameters"]["type"] == "object"

    # 显式关闭审批门后，auto_edit 不应再有 run。
    monkeypatch.setenv("CODE_AGENT_COMMAND_APPROVAL", "0")
    tools_disabled = build_openai_tools(execution_mode="auto_edit")
    names_disabled = {tool["function"]["name"] for tool in tools_disabled}
    assert "run" not in names_disabled


def test_build_openai_tools_full_auto_includes_run() -> None:
    """full_auto 模式额外包含 run 工具。"""

    tools = build_openai_tools(execution_mode="full_auto")
    names = {tool["function"]["name"] for tool in tools}
    assert "run" in names


def test_openai_message_serializes_tool_calls_and_results() -> None:
    """assistant 的 tool_calls 与 tool 角色结果应序列化为 OpenAI 格式。"""

    client = LlmProtocolClient.__new__(LlmProtocolClient)  # 仅测转换，不发起请求

    assistant = LlmMessage(
        role="assistant",
        content="",
        tool_calls=[
            LlmToolCall(
                name="read",
                arguments=json.dumps({"action": "read", "paths": ["a.ts"]}),
                id="call_1",
            )
        ],
    )
    payload = client._to_openai_message(assistant)
    assert payload["tool_calls"][0]["function"]["name"] == "read"
    assert "arguments" in payload["tool_calls"][0]["function"]

    tool_result = LlmMessage(
        role="tool",
        content="OBSERVATION: ...",
        tool_call_id="call_1",
    )
    payload = client._to_openai_message(tool_result)
    assert payload["role"] == "tool"
    assert payload["tool_call_id"] == "call_1"
    assert payload["content"] == "OBSERVATION: ..."


@pytest.mark.asyncio
async def test_complete_accumulates_unnamed_id_tool_call_fragments(monkeypatch) -> None:
    """DeepSeek 流式 tool_calls 分片不带 id 时，arguments 应完整拼回而非拆散。"""

    from backend.services.llm.catalog import get_model
    from backend.services.llm.gateway import LlmCredentials, LlmGateway

    gateway = LlmGateway()
    fragments = [
        LlmToolCall(name="edit", arguments="", id=""),
        LlmToolCall(name="", arguments='{"action":"read","paths":["a.ts"]', id=""),
        LlmToolCall(name="", arguments="}", id=""),
    ]
    monkeypatch.setattr(
        gateway,
        "_stream_with_deadline",
        lambda **_: _iter_chunks(fragments),
    )
    model = get_model("deepseek-v4-flash")
    assert model is not None
    monkeypatch.setattr(gateway, "resolve_candidates", lambda *_: (model,))
    monkeypatch.setattr(
        "backend.services.llm.gateway.AVAILABILITY.mark_success",
        lambda *_: None,
    )

    text, usage, _model = await gateway._complete_impl(
        preferred_model_id="deepseek-v4-flash",
        credentials=LlmCredentials(values={}),
        messages=[LlmMessage("user", "hi")],
    )

    assert text == '{"action":"read","paths":["a.ts"]}'
