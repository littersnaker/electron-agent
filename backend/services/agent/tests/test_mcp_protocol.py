"""Code Agent 协议对 MCP 动作的解析与校验。"""

from __future__ import annotations

import pytest

from backend.services.agent.shared.loop_protocol import parse_agent_action


def test_parse_agent_action_mcp() -> None:
    """模型可输出 mcp 动作：tool 名称与参数被解析保留。"""

    action = parse_agent_action(
        '{"action":"mcp","tool":"mcp__srv__do_thing","arguments":{"x":1}}'
    )
    assert action.action == "mcp"
    assert action.tool == "mcp__srv__do_thing"
    assert action.arguments == {"x": 1}


def test_parse_agent_action_mcp_requires_tool() -> None:
    """mcp 动作缺少 tool 时按协议错误拒绝。"""

    with pytest.raises(ValueError, match="mcp 动作缺少 tool"):
        parse_agent_action('{"action":"mcp","arguments":{}}')
