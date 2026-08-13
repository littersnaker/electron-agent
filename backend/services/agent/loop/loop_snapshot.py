"""WorkList 调度快照和 UI 指标聚合。"""

from __future__ import annotations

from typing import Any

from backend.services.agent.planner.task_planner import WorkLedger
from backend.services.agent.shared.work_state import WorkWorkerState
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


async def attach_step_metrics(snapshot: dict[str, Any], session_id: str) -> dict[str, Any]:
    """附加本次会话的 LLM 性能指标聚合（TTFT / tok/s / token）。"""

    if not session_id:
        return snapshot
    try:
        from backend.services.quality.step_metrics import aggregate_step_metrics

        snapshot["stepMetrics"] = await aggregate_step_metrics(session_id)
    except Exception:  # noqa: BLE001 - 指标聚合失败不影响快照。
        snapshot["stepMetrics"] = {}
    return snapshot


__all__ = ["build_scheduler_snapshot"]
