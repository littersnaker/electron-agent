"""不同兼容模型的工具协议修复测试。"""

from __future__ import annotations

import pytest

from backend.services.agent.shared.loop_protocol import parse_agent_action


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


def test_read_accepts_target_files_alias() -> None:
    """模型把路径字段写成 targetFiles 或 files 时也应识别。"""

    action = parse_agent_action(
        '{"action":"read","workId":"W001","targetFiles":["src/mock/user.ts"]}'
    )

    assert action.action == "read"
    assert action.paths == ["src/mock/user.ts"]

    inspect = parse_agent_action(
        '{"action":"inspect","workId":"W001","files":"src/mock/user.ts"}'
    )

    assert inspect.action == "inspect"
    assert inspect.paths == ["src/mock/user.ts"]


def test_edit_accepts_single_operation_object() -> None:
    """operations 写成单个对象而不是数组时应自动包装。"""

    action = parse_agent_action(
        '{"action":"edit","workId":"W001","operations":'
        '{"type":"write","path":"src/new.ts","content":"export const a = 1;"}}'
    )

    assert action.action == "edit"
    assert len(action.operations) == 1
    assert action.operations[0].type == "write"
    assert action.operations[0].path == "src/new.ts"


def test_write_rejects_empty_or_whitespace_content() -> None:
    """write 空内容/占位内容必须报协议错误，避免生成空文件后空转。"""

    with pytest.raises(ValueError, match="非空 content"):
        parse_agent_action(
            '{"action":"edit","workId":"W001","operations":'
            '[{"type":"write","path":"src/a.ts","content":""}]}'
        )

    with pytest.raises(ValueError, match="非空 content"):
        parse_agent_action(
            '{"action":"edit","workId":"W001","operations":'
            '[{"type":"write","path":"src/a.ts","content":"   "}]}'
        )


def test_edit_allows_empty_operations_as_no_change_signal() -> None:
    """空 operations 的 edit 表示“目标已满足”，协议层应允许由调用方判定。"""

    action = parse_agent_action(
        '{"action":"edit","workId":"W001","summary":"已满足，无需修改","operations":[]}'
    )

    assert action.action == "edit"
    assert action.operations == []


def test_read_rejects_empty_paths() -> None:
    """没有可用路径的 read 动作仍必须报协议错误，不能静默执行。"""

    with pytest.raises(ValueError, match="read 动作必须包含 paths"):
        parse_agent_action('{"action":"read","workId":"W001","paths":[]}')

    with pytest.raises(ValueError, match="read 动作必须包含 paths"):
        parse_agent_action('{"action":"read","workId":"W001"}')


def test_tool_style_complete_work_keeps_top_level_work_id() -> None:
    """tool 风格且无 arguments 包装时，顶层 work_id/workId 不能被丢弃。"""

    action = parse_agent_action(
        '{"tool":"complete_work","work_id":"W001","summary":"已完成","accepted":true}'
    )
    assert action.action == "complete_work"
    assert action.work_id == "W001"

    action = parse_agent_action(
        '{"tool":"complete_work","workId":"W001","summary":"已完成"}'
    )
    assert action.work_id == "W001"

    action = parse_agent_action(
        '{"action":"complete_work","workid":"w002","summary":"完成"}'
    )
    assert action.work_id == "W002"


def test_tool_style_read_with_param_files() -> None:
    """tool + param.files 的嵌套参数应归一化为 read paths。"""

    action = parse_agent_action(
        '{"tool":"read","param":{"files":["config/index.ts","src/index.html"]}}'
    )

    assert action.action == "read"
    assert action.paths == ["config/index.ts", "src/index.html"]


def test_edit_accepts_payload_operations_and_field_aliases() -> None:
    """edit 的 payload.operations 与 file/search/replace 别名应可解析。"""

    action = parse_agent_action(
        '{"action":"edit","payload":{"operations":'
        '[{"type":"replace","file":"config/index.ts","search":"a","replace":"b"}]}}'
    )

    assert action.action == "edit"
    assert len(action.operations) == 1
    operation = action.operations[0]
    assert operation.type == "replace"
    assert operation.path == "config/index.ts"
    assert operation.old_text == "a"
    assert operation.new_text == "b"


def test_edit_accepts_op_match_replace_aliases() -> None:
    """edit operation 的 op/match/replace 别名应映射到 type/old/new。"""

    action = parse_agent_action(
        '{"action":"edit","workId":"W001","operations":'
        '[{"op":"replace","path":"config/index.ts","match":"a","replace":"b"}]}'
    )

    assert action.action == "edit"
    assert action.work_id == "W001"
    assert action.operations[0].type == "replace"
    assert action.operations[0].old_text == "a"
    assert action.operations[0].new_text == "b"


def test_read_accepts_nested_payload_and_dict_paths() -> None:
    """read 的嵌套 payload.paths 与对象数组路径都应归一化。"""

    action = parse_agent_action(
        '{"action":"read","payload":{"paths":["a.ts","b.ts"]}}'
    )
    assert action.paths == ["a.ts", "b.ts"]

    action = parse_agent_action(
        '{"action":"read","workId":"W001","paths":[{"path":"a.ts"},{"file":"b.ts"}]}'
    )
    assert action.work_id == "W001"
    assert action.paths == ["a.ts", "b.ts"]


def test_action_name_aliases_expand_common_tool_names() -> None:
    """常见工具全名应映射到内部动作，例如 read_file / edit_file / complete_task。"""

    assert parse_agent_action(
        '{"tool":"read_file","arguments":{"paths":["a.ts"]}}'
    ).action == "read"
    assert parse_agent_action(
        '{"tool":"edit_file","arguments":{"workId":"W001","path":"a.ts","content":"x"}}'
    ).action == "edit"
    assert parse_agent_action(
        '{"tool":"complete_task","work_id":"W001","summary":"ok"}'
    ).action == "complete_work"


def test_action_name_as_root_key_with_list() -> None:
    """{"read": ["a.ts"]} 这类动作名作根键的列表形式应归一化为 read。"""

    action = parse_agent_action(
        '{"read": ["src/pages/category/index.tsx", "src/pages/category/index.scss"]}'
    )

    assert action.action == "read"
    assert action.paths == [
        "src/pages/category/index.tsx",
        "src/pages/category/index.scss",
    ]


def test_action_name_as_root_key_with_object() -> None:
    """{"read": {"paths": [...]}} / {"complete_work": {...}} 根键对象应归一化。"""

    action = parse_agent_action('{"read": {"paths": ["a.ts", "b.ts"]}}')
    assert action.action == "read"
    assert action.paths == ["a.ts", "b.ts"]

    done = parse_agent_action(
        '{"complete_work": {"workId": "W001", "summary": "已完成"}}'
    )
    assert done.action == "complete_work"
    assert done.work_id == "W001"
    assert done.summary == "已完成"


def test_tool_style_read_with_targets_alias() -> None:
    """tool 风格的 targets 字段应归一化为 read paths。"""

    action = parse_agent_action(
        '{"tool":"read","targets":["config/index.ts","src/index.html"]}'
    )

    assert action.action == "read"
    assert action.paths == ["config/index.ts", "src/index.html"]


def test_action_name_as_root_key_with_bare_string() -> None:
    """{"search": "cart"} 这类根键字符串应归一化为 query。"""

    action = parse_agent_action('{"search": "cart"}')

    assert action.action == "search"
    assert action.query == "cart"


def test_action_name_as_root_key_with_edit_operations() -> None:
    """{"edit": {...operations}} 根键对象应归一化为 edit。"""

    action = parse_agent_action(
        '{"edit": {"workId": "W001", "operations": '
        '[{"type":"write","path":"src/new.ts","content":"export const a = 1;"}]}}'
    )

    assert action.action == "edit"
    assert action.work_id == "W001"
    assert action.operations[0].type == "write"
    assert action.operations[0].path == "src/new.ts"
