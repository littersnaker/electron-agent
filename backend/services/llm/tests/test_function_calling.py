"""原生 Function Calling 接入测试：工具 Schema 生成与协议解析。"""

from __future__ import annotations

import json

from backend.services.agent.shared.tool_registry import build_openai_tools
from backend.services.llm.protocols import LlmProtocolClient
from backend.services.llm.types import LlmMessage, LlmToolCall


def test_build_openai_tools_covers_auto_edit_actions() -> None:
    """auto_edit 模式应生成全部 Worker 动作的工具 Schema。"""

    tools = build_openai_tools(execution_mode="auto_edit")
    names = {tool["function"]["name"] for tool in tools}

    assert {"search", "read", "edit", "complete_work", "finish"} <= names
    assert "run" not in names  # auto_edit 无 run
    # 每个工具都带函数参数 Schema。
    for tool in tools:
        assert tool["type"] == "function"
        assert "parameters" in tool["function"]
        assert tool["function"]["parameters"]["type"] == "object"


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
