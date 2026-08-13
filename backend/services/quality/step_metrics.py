"""LLM 单步性能指标（TTFT / tok/s / token）落库仓储。"""

from __future__ import annotations

from typing import Any

from backend.services.workspace.database import open_database, utc_now_iso


async def record_step_metric(
    *,
    request_id: str,
    session_id: str,
    work_id: str,
    provider: str,
    model: str,
    ttft_ms: int | None,
    tok_per_sec: float | None,
    prompt_tokens: int,
    completion_tokens: int,
    cached_tokens: int,
    total_ms: int,
) -> None:
    """写入一次 LLM 调用的性能指标（gateway audit 落盘处调用）。"""

    async with open_database() as connection:
        await connection.execute(
            "INSERT INTO agent_step_metrics "
            "(request_id, session_id, work_id, provider, model, ttft_ms, "
            "tok_per_sec, prompt_tokens, completion_tokens, cached_tokens, "
            "total_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                request_id,
                session_id,
                work_id,
                provider,
                model,
                int(ttft_ms) if ttft_ms is not None else None,
                float(tok_per_sec) if tok_per_sec is not None else None,
                prompt_tokens,
                completion_tokens,
                cached_tokens,
                total_ms,
                utc_now_iso(),
            ),
        )


async def aggregate_step_metrics(session_id: str) -> dict[str, Any]:
    """按会话聚合本次任务的性能指标（供 WORKLIST_UPDATE 下发）。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT COUNT(*) AS n, "
            "AVG(ttft_ms) AS avg_ttft, AVG(tok_per_sec) AS avg_tps, "
            "SUM(prompt_tokens) AS sum_prompt, SUM(completion_tokens) AS sum_completion, "
            "SUM(cached_tokens) AS sum_cached "
            "FROM agent_step_metrics WHERE session_id = ?",
            (session_id,),
        )
        row = await cursor.fetchone()
    if row is None or not row["n"]:
        return {
            "steps": 0,
            "avgTtftMs": None,
            "avgTokPerSec": None,
            "totalPromptTokens": 0,
            "totalCompletionTokens": 0,
            "totalCachedTokens": 0,
        }
    return {
        "steps": int(row["n"]),
        "avgTtftMs": int(round(float(row["avg_ttft"]))) if row["avg_ttft"] is not None else None,
        "avgTokPerSec": (
            round(float(row["avg_tps"]), 1) if row["avg_tps"] is not None else None
        ),
        "totalPromptTokens": int(row["sum_prompt"] or 0),
        "totalCompletionTokens": int(row["sum_completion"] or 0),
        "totalCachedTokens": int(row["sum_cached"] or 0),
    }


__all__ = ["aggregate_step_metrics", "record_step_metric"]
