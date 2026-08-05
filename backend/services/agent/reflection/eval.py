"""评测闭环：记忆注入命中率（任务输出是否实际引用了注入的记忆）。"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from backend.core import request_audit
from backend.services.workspace.database import (
    open_database,
    utc_now_iso,
)

LOGGER = logging.getLogger(__name__)


async def _memory_content_by_ids(memory_ids: list[str]) -> dict[str, str]:
    """按 id 读取记忆内容，供命中比对。"""

    if not memory_ids:
        return {}
    placeholders = ",".join("?" for _ in memory_ids)
    async with open_database() as connection:
        cursor = await connection.execute(
            f"""
            SELECT id, content FROM agent_memories
            WHERE id IN ({placeholders})
            """,
            tuple(memory_ids),
        )
        rows = await cursor.fetchall()
    return {str(row["id"]): str(row["content"]) for row in rows}


def _task_output_text(task_id: str, audit_dir: str | None = None) -> str:
    """汇总某任务的 LLM 输出文本（审计日志按 parentRequestId 关联）。"""

    parts: list[str] = []
    for entry in request_audit.iter_entries(audit_dir):
        agent = entry.get("agent") or {}
        if not isinstance(agent, dict):
            continue
        if agent.get("parentRequestId") != task_id:
            continue
        response = entry.get("response") or {}
        text = str(response.get("text") or "")
        if text:
            parts.append(text)
    return "\n".join(parts)


def _count_hits(contents: dict[str, str], output_text: str) -> int:
    """把记忆内容的前 24 个字符作为指纹，出现在任务输出中即视为命中。"""

    if not contents or not output_text:
        return 0
    hits = 0
    for content in contents.values():
        fingerprint = " ".join(content.split())[:24]
        if fingerprint and fingerprint in output_text:
            hits += 1
    return hits


async def record_memory_eval(
    *,
    task_id: str,
    agent_id: str,
    memory_ids: list[str],
    audit_dir: str | None = None,
) -> None:
    """记录一次任务的记忆注入命中情况（纯本地计算，无 LLM 调用）。"""

    try:
        contents = await _memory_content_by_ids(memory_ids)
        output_text = _task_output_text(task_id, audit_dir)
        hits = _count_hits(contents, output_text)
        async with open_database() as connection:
            await connection.execute(
                """
                INSERT INTO memory_eval(task_id, agent_id, injected, hit, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    agent_id,
                    len(contents),
                    hits,
                    utc_now_iso(),
                ),
            )
    except Exception:
        LOGGER.exception("记忆命中评估失败（task=%s）", task_id)


async def memory_eval_stats() -> dict[str, Any]:
    """汇总记忆注入/命中统计。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            """
            SELECT COUNT(*) AS tasks,
                   COALESCE(SUM(injected), 0) AS injected,
                   COALESCE(SUM(hit), 0) AS hit
            FROM memory_eval
            """
        )
        row = await cursor.fetchone()
    tasks = int(row["tasks"] or 0)
    injected = int(row["injected"] or 0)
    hit = int(row["hit"] or 0)
    return {
        "tasks": tasks,
        "injected": injected,
        "hit": hit,
        "hitRate": round(hit / injected, 4) if injected else 0.0,
    }


async def schedule_memory_eval(
    *,
    task_id: str,
    agent_id: str,
    memory_ids: list[str],
) -> None:
    """fire-and-forget 调度（任务完成后调用，不影响主流程）。"""

    if not task_id or not memory_ids:
        return
    asyncio.create_task(
        record_memory_eval(
            task_id=task_id,
            agent_id=agent_id,
            memory_ids=list(memory_ids),
        )
    )
