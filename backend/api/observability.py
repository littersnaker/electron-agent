"""Agent Trace 可观测性接口。"""

from __future__ import annotations

from fastapi import APIRouter, Query

from backend.services.agent.loop.trace import get_trace_events, list_recent_traces

router = APIRouter(tags=["observability"])


def _empty_cache_stats() -> dict[str, object]:
    """返回与旧前端兼容的空缓存统计。"""

    return {
        "entries": 0,
        "hits": 0,
        "misses": 0,
        "writes": 0,
        "evictions": 0,
        "hitRate": 0,
    }


@router.get("/api/agent/observability")
async def get_observability(
    trace_id: str | None = Query(default=None, alias="traceId"),
    limit: int = Query(default=30, ge=1, le=100),
) -> dict[str, object]:
    """返回最近 Trace 列表或单条 Trace 详情。"""

    if trace_id:
        return {
            "traceId": trace_id,
            "events": await get_trace_events(trace_id),
            "evaluation": None,
            "contextCache": _empty_cache_stats(),
        }
    return {
        "traces": await list_recent_traces(limit),
        "contextCache": _empty_cache_stats(),
    }
