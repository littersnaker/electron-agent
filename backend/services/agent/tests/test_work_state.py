"""WorkWorkerState 存储层 transcript 完整性测试。"""

from __future__ import annotations

from backend.services.agent.work_state import WorkWorkerState


def test_single_entry_is_preserved_fully() -> None:
    """超大单条观察必须完整保留，单次任务内不做截断。"""

    state = WorkWorkerState()

    state.append_transcript("ACTION read paths=['big.ts']\nOBSERVATION:\n" + "x" * 200_000)

    assert len(state.transcript) == 1
    assert state.transcript[0].endswith("x" * 200_000)
    assert len(state.transcript[0]) == len("ACTION read paths=['big.ts']\nOBSERVATION:\n") + 200_000


def test_total_transcript_is_preserved() -> None:
    """累计 transcript 完整保留，单次任务内不做总量裁剪。"""

    state = WorkWorkerState()
    head = "WORK CONTEXT: 目标上下文"
    state.append_transcript(head)
    state.append_transcript("RELATED FILES: 预读文件摘要")
    state.append_transcript("DIRECTIVE: 继续执行")
    for index in range(200):
        state.append_transcript(f"ACTION read paths=[{index}]\nOBSERVATION:\n" + ("代码" * 1_000))

    total = sum(len(item) for item in state.transcript)

    assert state.transcript[0] == head
    assert "ACTION read paths=[199]" in state.transcript[-1]
    assert len(state.transcript) == 203
    assert total > 200_000
