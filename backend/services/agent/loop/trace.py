"""Code Agent 运行 Trace 的持久化模块。"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from backend.services.workspace.database import dumps_json, loads_json, open_database, utc_now_iso


@dataclass(slots=True)
class TraceHandle:
    """保存当前 Trace 的标识和起始时间。"""

    trace_id: str
    started_monotonic: float
    sequence: int = 0


async def start_trace(
    *, session_id: str, project_id: str, model: str, request_preview: str
) -> TraceHandle:
    """创建一条运行中的根 Trace。"""

    trace_id = f"trace_{uuid4().hex}"
    async with open_database() as connection:
        await connection.execute(
            "INSERT INTO traces "
            "(id, session_id, project_id, model, request_preview, status, started_at) "
            "VALUES (?, ?, ?, ?, ?, 'running', ?)",
            (
                trace_id,
                session_id,
                project_id,
                model,
                request_preview[:500],
                utc_now_iso(),
            ),
        )
    return TraceHandle(trace_id, time.monotonic())


async def add_trace_event(
    handle: TraceHandle,
    *,
    category: str,
    name: str,
    status: str,
    metadata: dict[str, Any] | None = None,
    duration_ms: int | None = None,
) -> None:
    """向当前 Trace 追加一个有序事件。"""

    handle.sequence += 1
    async with open_database() as connection:
        await connection.execute(
            "INSERT INTO trace_events "
            "(trace_id, sequence, category, name, status, duration_ms, metadata_json, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (
                handle.trace_id,
                handle.sequence,
                category,
                name,
                status,
                duration_ms,
                dumps_json(metadata or {}),
                utc_now_iso(),
            ),
        )


async def finish_trace(
    handle: TraceHandle, *, status: str, error_message: str | None = None
) -> None:
    """结束 Trace 并写入总耗时。"""

    duration_ms = int((time.monotonic() - handle.started_monotonic) * 1000)
    async with open_database() as connection:
        await connection.execute(
            "UPDATE traces SET status = ?, finished_at = ?, duration_ms = ?, "
            "error_message = ? WHERE id = ?",
            (status, utc_now_iso(), duration_ms, error_message, handle.trace_id),
        )


async def list_recent_traces(limit: int) -> list[dict[str, Any]]:
    """返回最近的根 Trace 列表。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT t.*, COUNT(e.id) AS event_count FROM traces t "
            "LEFT JOIN trace_events e ON e.trace_id = t.id "
            "GROUP BY t.id ORDER BY t.started_at DESC LIMIT ?",
            (limit,),
        )
        rows = await cursor.fetchall()
    return [
        {
            "id": row["id"],
            "sessionId": row["session_id"],
            "projectId": row["project_id"],
            "model": row["model"],
            "requestPreview": row["request_preview"],
            "status": row["status"],
            "startedAt": row["started_at"],
            "finishedAt": row["finished_at"],
            "durationMs": row["duration_ms"],
            "errorMessage": row["error_message"],
            "eventCount": row["event_count"],
        }
        for row in rows
    ]


async def get_trace_events(trace_id: str) -> list[dict[str, Any]]:
    """返回指定 Trace 的完整事件时间线。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT * FROM trace_events WHERE trace_id = ? ORDER BY sequence ASC",
            (trace_id,),
        )
        rows = await cursor.fetchall()
    return [
        {
            "id": row["id"],
            "traceId": row["trace_id"],
            "sequence": row["sequence"],
            "category": row["category"],
            "name": row["name"],
            "status": row["status"],
            "durationMs": row["duration_ms"],
            "metadata": loads_json(row["metadata_json"], {}),
            "createdAt": row["created_at"],
        }
        for row in rows
    ]
