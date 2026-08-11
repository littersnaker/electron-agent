"""Token 预算软信号与紧急压缩的单元测试。"""

from __future__ import annotations

from backend.services.agent.context.context_compactor import ContextCompactor
from backend.services.agent.runtime.work_session import WorkIntelligenceSession
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import WorkWorkerState


def _session() -> tuple[WorkIntelligenceSession, WorkWorkerState]:
    work = WorkItem(id="W001", title="分类页移动端适配", objective="把固定 px 改为 rpx")
    state = WorkWorkerState()
    return WorkIntelligenceSession(work, state), state


def test_compact_transcript_budget_keeps_recent_tail_verbatim() -> None:
    """紧急压缩应完整保留最近若干条观察，只裁剪更早的大段工具输出。"""

    compactor = ContextCompactor(max_work_context_token=100, max_tool_output_token=30)
    huge_old = "ACTION read a.ts\nOBSERVATION:\n" + "x" * 2_000
    transcript = [
        huge_old,
        "old b",
        "old c",
        "old d",
        "old e",
        "old f",
        "recent g",
        "recent h",
    ]

    compacted, stats = compactor.compact_transcript_budget(transcript)

    assert stats["saved_tokens"] > 0
    assert len(compacted) == len(transcript)
    assert compacted[0].endswith("预算截断）")
    assert compacted[-2:] == ["recent g", "recent h"]


def test_budget_directive_soft_signal_levels() -> None:
    """正常时无指令；剩余不足时给警告；接近/超限时给强制收尾指令。"""

    session, _ = _session()
    budget = session.budget.get("worker")
    limit = budget.limit

    budget.consume(limit // 10)
    assert session.budget_directive(budget, 1_000) == ""

    budget.consume(limit // 2)
    warning = session.budget_directive(budget, 1_000)
    assert "BUDGET WARNING" in warning

    budget.consume(limit)
    urgent = session.budget_directive(budget, 10_000)
    assert "BUDGET EXHAUSTED" in urgent
    assert "禁止 read/search/inspect" in urgent


def test_compact_for_budget_runs_once_and_clears_versions() -> None:
    """预算压缩只执行一次，并清空文件版本指纹防止模型误读截断内容。"""

    session, state = _session()
    state.transcript = [
        "ACTION read a.ts\nOBSERVATION:\n" + "y" * 1_000,
        "ACTION edit a.ts\nCHANGED: a.ts\nDIFF: z",
    ]
    state.transcript_versions["a.ts"] = "v1"

    assert session.compact_for_budget() is True
    assert state.quality.get("budgetCompacted") is True
    assert "a.ts" not in state.transcript_versions
    assert session.compact_for_budget() is False


def test_record_usage_compacts_before_blocking() -> None:
    """首次触发硬止损阈值应压缩并允许继续收尾，压缩后仍超限才返回 False。"""

    session, state = _session()
    state.append_transcript("WORK CONTEXT: 目标")
    state.append_transcript("ACTION read a.ts\nOBSERVATION:\n" + "y" * 1_000)

    assert session.record_usage(180_000) is True  # 未到 1.5× 硬止损阈值
    assert session.record_usage(100_000) is True  # 触发 block，但先压缩放行收尾
    assert session.record_usage(10_000) is False  # 已压缩过，硬止损


def test_record_usage_blocks_immediately_when_nothing_to_compact() -> None:
    """上下文本身为空/极小、压缩无事可做时，block 应立即返回 False。"""

    session, _ = _session()

    assert session.record_usage(300_000) is False
