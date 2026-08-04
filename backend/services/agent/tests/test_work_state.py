"""WorkWorkerState 存储层 transcript 上限测试。"""

from __future__ import annotations

from backend.services.agent.work_state import (
    MAX_TRANSCRIPT_ENTRY_CHARS,
    MAX_TRANSCRIPT_TOTAL_CHARS,
    WorkWorkerState,
)


def test_single_entry_is_truncated_to_entry_budget() -> None:
    """超大单条观察必须在 append 时截断，不能全文进入内存。"""

    state = WorkWorkerState()

    state.append_transcript("ACTION read paths=['big.ts']\nOBSERVATION:\n" + "x" * 200_000)

    assert len(state.transcript) == 1
    assert len(state.transcript[0]) <= MAX_TRANSCRIPT_ENTRY_CHARS
    assert "已按存储预算截断" in state.transcript[0]


def test_total_transcript_is_bounded_and_keeps_head() -> None:
    """累计 transcript 超过预算时保留开头上下文与最近动作，丢弃中间。"""

    state = WorkWorkerState()
    head = "WORK CONTEXT: 目标上下文"
    state.append_transcript(head)
    state.append_transcript("RELATED FILES: 预读文件摘要")
    state.append_transcript("DIRECTIVE: 继续执行")
    for index in range(200):
        state.append_transcript(f"ACTION read paths=[{index}]\nOBSERVATION:\n" + ("代码" * 1_000))

    total = sum(len(item) for item in state.transcript)

    assert total <= MAX_TRANSCRIPT_TOTAL_CHARS
    assert state.transcript[0] == head
    assert "ACTION read paths=[199]" in state.transcript[-1]
    assert len(state.transcript) < 200
