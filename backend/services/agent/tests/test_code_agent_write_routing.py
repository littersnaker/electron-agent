"""Code Agent 读写模式切换与混合意图路由回归测试。"""

from __future__ import annotations

import pytest

from backend.schemas.chat import ChatRequest
from backend.services.agent.planner.classifier import classify_request
from backend.services.agent.planner.request_routing import route_code_request


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("为什么只分析代码不干活，这次要帮我把活干完才行", "code_change"),
        ("不要只分析，把代码写完并运行测试", "code_change"),
        ("先分析失败原因，然后直接修复并验证", "code_change"),
        ("不要修改后端，只修改前端购物车页面", "code_change"),
        ("切回读写模式，继续完成当前任务", "code_change"),
        ("恢复全自动权限", "code_change"),
        ("先分析失败原因，不要修改任何文件", "read_only"),
        # 陈述式修改需求（无“修改/实现/做”动词）在可写模式下默认按代码修改处理。
        ("首页的swiper顶部固定，为你推荐做滚动处理", "code_change"),
    ],
)
def test_mixed_read_and_write_intent_is_classified_correctly(
    text: str,
    expected: str,
) -> None:
    """混合指令应按最终交付意图路由，而不是只看“分析”或“修改”单个词。"""

    result = classify_request(
        text,
        agent_mode="full_auto",
        conversation_text="把这个项目做成电商小程序",
    )

    assert result == expected


def test_declarative_change_request_is_code_change_in_auto_edit() -> None:
    """无动词陈述式修改需求在 auto_edit 下应进入 code_change。"""

    result = classify_request(
        "首页的swiper顶部固定，为你推荐做滚动处理",
        agent_mode="auto_edit",
    )

    assert result == "code_change"


def test_declarative_change_request_stays_read_only_in_suggest() -> None:
    """同一陈述式需求在 suggest（纯建议）模式下仍只分析。"""

    result = classify_request(
        "首页的swiper顶部固定，为你推荐做滚动处理",
        agent_mode="suggest",
    )

    assert result == "read_only"


def test_read_keyword_wins_over_auto_edit_default() -> None:
    """读关键词（“解释/怎么”）在 auto_edit 下仍保持只读，不被兜底改写。"""

    assert (
        classify_request("解释一下首页的布局结构", agent_mode="auto_edit")
        == "read_only"
    )


def test_read_only_complaint_switches_back_to_full_auto_tools() -> None:
    """“为什么只分析”投诉应恢复当前全自动会话的写入与命令工具。"""

    body = ChatRequest.model_validate(
        {
            "messages": [
                {"role": "user", "content": "把这个项目做成电商小程序"},
                {
                    "role": "assistant",
                    "content": "当前只读工具为 search/read/inspect/finish。",
                },
                {
                    "role": "user",
                    "content": "为什么只分析代码不干活，这次帮我把活干完并测试",
                },
            ],
            "agentMode": "full_auto",
        }
    )

    routed = route_code_request(body, body.messages[-1].content)

    assert routed.mode == "code_change"
    assert {"edit", "run"} <= set(routed.tool_names)
    assert "把这个项目做成电商小程序" in routed.effective_text


def test_auto_edit_complaint_restores_edit_without_run(monkeypatch) -> None:
    """关闭命令审批门时自动编辑模式应恢复 edit，但不暴露 run。"""

    monkeypatch.setenv("CODE_AGENT_COMMAND_APPROVAL", "0")

    body = ChatRequest.model_validate(
        {
            "messages": [
                {"role": "user", "content": "修复订单详情页并补齐路由"},
                {"role": "assistant", "content": "本轮只能只读分析。"},
                {"role": "user", "content": "不要只分析，继续修改并完成"},
            ],
            "agentMode": "auto_edit",
        }
    )

    routed = route_code_request(body, body.messages[-1].content)

    assert routed.mode == "code_change"
    assert "edit" in routed.tool_names
    assert "run" not in routed.tool_names


def test_auto_edit_exposes_run_only_with_approval(monkeypatch) -> None:
    """审批门开启时自动编辑模式暴露 run（仅供安装命令走审批）。"""

    monkeypatch.setenv("CODE_AGENT_COMMAND_APPROVAL", "1")
    body = ChatRequest.model_validate(
        {
            "messages": [
                {"role": "user", "content": "修复订单详情页并补齐路由"},
                {"role": "assistant", "content": "本轮只能只读分析。"},
                {"role": "user", "content": "不要只分析，继续修改并完成"},
            ],
            "agentMode": "auto_edit",
        }
    )
    routed = route_code_request(body, body.messages[-1].content)
    assert routed.mode == "code_change"
    assert "edit" in routed.tool_names
    assert "run" in routed.tool_names
