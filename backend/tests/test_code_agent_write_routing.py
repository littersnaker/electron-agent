"""Code Agent 读写模式切换与混合意图路由回归测试。"""

from __future__ import annotations

import pytest

from backend.schemas.chat import ChatRequest
from backend.services.agent.classifier import classify_request
from backend.services.agent.request_routing import route_code_request


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
        ("优化一下首页加载速度", "code_change"),
        ("把后端接口接上前端页面", "code_change"),
        ("把订单数据接上购物车页面", "code_change"),
        ("写一个 README 并提交", "code_change"),
        ("写个启动脚本", "code_change"),
        ("绑定用户协议到注册页", "code_change"),
        ("补齐订单列表的缺失字段", "code_change"),
        ("做好商品详情的加载状态", "code_change"),
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


def test_auto_edit_complaint_restores_edit_without_run() -> None:
    """自动编辑模式应恢复 edit，但不能越权暴露 run。"""

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
