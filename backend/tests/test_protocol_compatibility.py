"""不同兼容模型的工具协议修复测试。"""

from __future__ import annotations

from backend.services.agent.loop_protocol import parse_agent_action
import pytest


def test_parser_uses_first_balanced_json_and_accepts_trailing_comma() -> None:
    """回复包含说明、多个对象和尾逗号时只执行首个完整动作。"""

    action = parse_agent_action(
        '说明：先读取。 {"action":"read","workId":"W001","paths":["a.ts"],} '
        '{"action":"run","command":"rm -rf /"}'
    )

    assert action.action == "read"
    assert action.paths == ["a.ts"]


def test_parser_accepts_openai_tool_call_wrapper() -> None:
    """OpenAI 风格 function 包装应转换为内部 read 协议。"""

    action = parse_agent_action(
        '{"function":{"name":"workspace.read","arguments":"{\\"workId\\":'
        '\\"W001\\",\\"paths\\":[\\"src/app.ts\\"]}"}}'
    )

    assert action.action == "read"
    assert action.work_id == "W001"
    assert action.paths == ["src/app.ts"]


def test_parser_accepts_simple_write_alias_for_new_file() -> None:
    """供应商返回 write/path/content 时应转换为可创建文件的 edit 操作。"""

    action = parse_agent_action(
        '{"action":"write","workId":"W009","path":"src/new.ts",'
        '"content":"export const created = true;\\n","summary":"创建入口"}'
    )

    assert action.action == "edit"
    assert action.work_id == "W009"
    assert len(action.operations) == 1
    assert action.operations[0].type == "write"
    assert action.operations[0].path == "src/new.ts"


def test_read_accepts_singular_path_field() -> None:
    """模型把 paths 写成 path（单数）时应自动归一化。"""

    action = parse_agent_action(
        '{"action":"read","workId":"W001","path":"src/mock/user.ts"}'
    )

    assert action.action == "read"
    assert action.paths == ["src/mock/user.ts"]


def test_read_accepts_comma_separated_string_paths() -> None:
    """paths 写成逗号分隔字符串时应拆成数组。"""

    action = parse_agent_action(
        '{"action":"read","workId":"W001","paths":"src/a.ts,src/b.ts"}'
    )

    assert action.paths == ["src/a.ts", "src/b.ts"]


def test_read_rejects_empty_paths() -> None:
    """没有可用路径的 read 动作仍必须报协议错误，不能静默执行。"""

    with pytest.raises(ValueError, match="read 动作必须包含 paths"):
        parse_agent_action('{"action":"read","workId":"W001","paths":[]}')

    with pytest.raises(ValueError, match="read 动作必须包含 paths"):
        parse_agent_action('{"action":"read","workId":"W001"}')
