"""Worker 迭代预算与协议快速收敛测试。

覆盖三项修复：
1. 协议错误轮（自然语言/非法 JSON）不消耗 10 轮迭代预算
2. 连续 2 次协议错误即失败交回 Planner，不在 Work 内继续空转
3. read 观察注入时带"完整内容已读取"标记，降低模型截断幻觉
"""

from __future__ import annotations

import inspect

from backend.services.agent.worker import work_action_handler, work_worker


def test_max_invalid_protocol_rounds_is_two() -> None:
    """协议错误最多给 2 次机会，避免在 Work 内长时间空转。"""

    assert work_worker.MAX_INVALID_PROTOCOL_ROUNDS == 2


def test_read_observation_marks_complete_content() -> None:
    """read 观察模板应带"完整内容已读取"标记，避免模型误判截断。"""

    source = inspect.getsource(work_action_handler)
    assert "完整内容已读取" in source
    assert "未截断" in source


def test_iteration_budget_only_consumed_on_valid_rounds() -> None:
    """attempt_iterations 累加应位于协议解析成功之后。"""

    source = inspect.getsource(work_worker)
    # 解析成功分支先清空违规计数，再累加有效轮预算。
    parse_block = source[source.index("action = parse_agent_action") :]
    success_part = parse_block[: parse_block.index("except ValueError")]
    assert "state.attempt_invalid_rounds = 0" in success_part
    assert "state.attempt_iterations += 1" in success_part
    # 调用前（usage 上报区）不得累加有效轮预算。
    usage_part = source[
        source.index("state.iterations += 1") : source.index("await emit(")
    ]
    assert "attempt_iterations" not in usage_part
