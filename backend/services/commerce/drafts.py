"""Listing 草稿的 SQLite 持久化与人工确认状态。"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

from backend.services.workspace.database import (
    dumps_json,
    loads_json,
    open_database,
    utc_now_iso,
)


async def save_listing_draft(
    *,
    session_id: str,
    query: str,
    marketplace: str,
    draft: dict[str, Any],
    source: str,
) -> str:
    """保存一条待人工确认的 Listing 草稿，返回 draft id。"""

    identifier = f"draft_{uuid4().hex}"
    now = utc_now_iso()
    async with open_database() as connection:
        await connection.execute(
            """
            INSERT INTO listing_drafts(
                id, session_id, query, marketplace, draft_json, source,
                status, notes, created_at, confirmed_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'pending', '', ?, NULL)
            """,
            (
                identifier,
                session_id,
                query,
                marketplace,
                dumps_json(draft),
                source,
                now,
            ),
        )
    return identifier


async def update_listing_draft_status(
    draft_id: str,
    status: str,
    notes: str = "",
) -> bool:
    """人工确认/驳回复核草稿。"""

    now = utc_now_iso()
    async with open_database() as connection:
        cursor = await connection.execute(
            """
            UPDATE listing_drafts
            SET status = ?, notes = ?, confirmed_at = ?
            WHERE id = ?
            """,
            (status, notes, now, draft_id),
        )
    return cursor.rowcount > 0


async def list_listing_drafts(
    *,
    status: str | None = None,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """列出草稿（默认 pending，供人工确认）。"""

    clauses: list[str] = []
    parameters: list[object] = []
    if status:
        clauses.append("status = ?")
        parameters.append(status)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    parameters.append(max(1, min(limit, 200)))
    async with open_database() as connection:
        cursor = await connection.execute(
            f"""
            SELECT * FROM listing_drafts
            {where}
            ORDER BY created_at DESC
            LIMIT ?
            """,
            tuple(parameters),
        )
        rows = await cursor.fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        result.append(
            {
                "id": str(row["id"]),
                "sessionId": str(row["session_id"]),
                "query": str(row["query"]),
                "marketplace": str(row["marketplace"]),
                "draft": loads_json(str(row["draft_json"]), {}),
                "source": str(row["source"]),
                "status": str(row["status"]),
                "notes": str(row["notes"]),
                "createdAt": str(row["created_at"]),
                "confirmedAt": (
                    str(row["confirmed_at"]) if row["confirmed_at"] else None
                ),
            }
        )
    return result
