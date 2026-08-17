"""MCP 工具执行器测试：解析、执行、审批门与错误降级。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.mcp import executor


@pytest.mark.asyncio
async def test_execute_mcp_tool_returns_content(monkeypatch) -> None:
    """普通工具执行成功：返回 MCP content 文本。"""

    async def fake_resolve(working_dir: Path, llm_name: str):
        return {"id": "srv"}, {
            "remoteName": "do_thing",
            "requiresApproval": False,
            "llmName": "mcp__srv__do_thing",
        }

    async def fake_call(server, *, tool_name, arguments):
        assert tool_name == "do_thing"
        assert arguments == {"x": 1}
        return {"content": [{"type": "text", "text": "done"}], "isError": False}

    monkeypatch.setattr(executor, "resolve_mcp_tool", fake_resolve)
    monkeypatch.setattr(executor, "call_tool", fake_call)
    result = await executor.execute_mcp_tool(
        Path("."), "mcp__srv__do_thing", {"x": 1}, approved=False
    )
    assert result["ok"] is True
    assert result["content"] == "done"


@pytest.mark.asyncio
async def test_execute_mcp_tool_approval_gate(monkeypatch) -> None:
    """需要审批的工具在未批准时返回 approvalNeeded，不执行调用。"""

    async def fake_resolve(working_dir: Path, llm_name: str):
        return {"id": "srv"}, {
            "remoteName": "danger",
            "requiresApproval": True,
            "llmName": "mcp__srv__danger",
        }

    called = False

    async def fake_call(server, *, tool_name, arguments):
        nonlocal called
        called = True
        return {"content": []}

    monkeypatch.setattr(executor, "resolve_mcp_tool", fake_resolve)
    monkeypatch.setattr(executor, "call_tool", fake_call)
    result = await executor.execute_mcp_tool(
        Path("."), "mcp__srv__danger", {}, approved=False
    )
    assert result["ok"] is False
    assert result["approvalNeeded"] is True
    assert called is False


@pytest.mark.asyncio
async def test_execute_mcp_tool_returns_error(monkeypatch) -> None:
    """调用失败时返回结构化 error，而不是抛异常。"""

    async def fake_resolve(working_dir: Path, llm_name: str):
        return {"id": "srv"}, {
            "remoteName": "fail",
            "requiresApproval": False,
            "llmName": "mcp__srv__fail",
        }

    async def fake_call(server, *, tool_name, arguments):
        raise RuntimeError("remote boom")

    monkeypatch.setattr(executor, "resolve_mcp_tool", fake_resolve)
    monkeypatch.setattr(executor, "call_tool", fake_call)
    result = await executor.execute_mcp_tool(Path("."), "mcp__srv__fail", {})
    assert result["ok"] is False
    assert "remote boom" in result["error"]
