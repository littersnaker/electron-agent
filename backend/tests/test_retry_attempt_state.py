"""Worker 重试状态隔离测试。"""

from __future__ import annotations

from backend.services.agent.work_state import WorkWorkerState
from backend.services.llm.types import LlmUsage


def test_new_attempt_resets_guard_but_preserves_artifacts_and_usage() -> None:
    """重试不能继承旧轮次熔断，同时必须保留真实修改和累计 Token。"""

    state = WorkWorkerState(
        transcript=["ACTION read\nOBSERVATION:\n大量旧输出"],
        changed_files=["src/cart.ts"],
        usage=LlmUsage(prompt=100, completion=20, total=120),
        failure_summary={"error": "模型协议失败"},
        attempt_number=1,
        attempt_iterations=16,
        attempt_invalid_rounds=3,
        context_actions=6,
        guard_rejections=2,
        write_actions=1,
    )

    state.begin_attempt(2)

    assert state.attempt_iterations == 0
    assert state.attempt_invalid_rounds == 0
    assert state.context_actions == 0
    assert state.guard_rejections == 0
    assert state.write_actions == 0
    assert state.changed_files == ["src/cart.ts"]
    assert state.usage.total == 120
    assert "模型协议失败" in "\n".join(state.transcript)
    assert "大量旧输出" not in "\n".join(state.transcript)
