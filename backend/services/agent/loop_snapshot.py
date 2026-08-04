"""WorkList 调度快照和 UI 指标聚合。"""

from __future__ import annotations

from typing import Any

from backend.services.agent.task_planner import WorkLedger
from backend.services.agent.work_state import WorkWorkerState
from backend.services.llm.types import LlmUsage


def build_scheduler_snapshot(
    ledger: WorkLedger,
    *,
    active_work_ids: list[str],
    parallel_limit: int,
    worker_states: dict[str, WorkWorkerState] | None = None,
    usage: LlmUsage | None = None,
    retry_count: int = 0,
    quality: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """在完整 WorkList 上附加并行、Token 和最终质量指标。"""

    snapshot = ledger.snapshot()
    snapshot["scheduler"] = {
        "mode": "dependency_graph",
        "maxParallel": parallel_limit,
        "activeWorkIds": list(active_work_ids),
    }
    states = worker_states or {}
    compressed = sum(
        int(dict(state.token_budget.get("context") or {}).get("compressed") or 0)
        for state in states.values()
    )
    cleaned = sum(
        int(dict(state.token_budget.get("context") or {}).get("cleaned") or 0)
        for state in states.values()
    )
    total = int(usage.total if usage else 0)
    snapshot["metrics"] = {
        "totalTokens": total,
        "activeTokens": max(0, total - compressed - cleaned),
        "compressedTokens": compressed,
        "cleanedTokens": cleaned,
        "completedWorks": int(snapshot.get("succeeded") or 0),
        "failedWorks": int(snapshot.get("failed") or 0),
        "retryCount": retry_count,
    }
    if quality:
        snapshot["quality"] = dict(quality)
    return snapshot


__all__ = ["build_scheduler_snapshot"]
