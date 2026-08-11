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

# 草稿状态机：仅待确认（pending）的草稿允许编辑、确认或驳回；
# 一旦进入已确认（confirmed）/ 已驳回（rejected）即终态，不可再变更。
PENDING = "pending"
CONFIRMED = "confirmed"
REJECTED = "rejected"

_TERMINAL_STATUSES = {CONFIRMED, REJECTED}

_STATUS_LABELS = {
    PENDING: "待确认",
    CONFIRMED: "已确认",
    REJECTED: "已驳回",
}

_DRAFT_COLUMNS = (
    "id, session_id, query, marketplace, draft_json, source, "
    "status, notes, created_at, confirmed_at, updated_at"
)


class DraftNotEditableError(Exception):
    """草稿处于终态（已确认/已驳回），禁止编辑或变更状态。"""

    def __init__(self, draft_id: str, status: str) -> None:
        """记录触发错误的草稿与当前状态。"""

        label = _STATUS_LABELS.get(status, status)
        super().__init__(f"Listing 草稿 {draft_id} 当前状态为{label}，不可再变更")
        self.draft_id = draft_id
        self.status = status


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
            f"""
            INSERT INTO listing_drafts({_DRAFT_COLUMNS})
            VALUES (?, ?, ?, ?, ?, ?, 'pending', '', ?, NULL, ?)
            """,
            (
                identifier,
                session_id,
                query,
                marketplace,
                dumps_json(draft),
                source,
                now,
                now,
            ),
        )
    return identifier


async def update_listing_draft_content(
    draft_id: str,
    draft: dict[str, Any],
    notes: str = "",
) -> bool:
    """更新一条待确认草稿的内容与备注，返回是否命中行。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT status FROM listing_drafts WHERE id = ?",
            (draft_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            return False
        status = str(row["status"])
        if status in _TERMINAL_STATUSES:
            raise DraftNotEditableError(draft_id, status)
        cursor = await connection.execute(
            """
            UPDATE listing_drafts
            SET draft_json = ?, notes = ?, updated_at = ?
            WHERE id = ?
            """,
            (dumps_json(draft), notes, utc_now_iso(), draft_id),
        )
    return cursor.rowcount > 0


async def update_listing_draft_status(
    draft_id: str,
    status: str,
    notes: str = "",
) -> bool:
    """人工确认/驳回复核草稿；终态草稿不可再变更。"""

    if status not in {CONFIRMED, REJECTED}:
        raise ValueError(f"不支持的草稿状态：{status}")
    now = utc_now_iso()
    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT status FROM listing_drafts WHERE id = ?",
            (draft_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            return False
        current = str(row["status"])
        if current in _TERMINAL_STATUSES:
            raise DraftNotEditableError(draft_id, current)
        cursor = await connection.execute(
            """
            UPDATE listing_drafts
            SET status = ?, notes = ?, confirmed_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, notes, now, now, draft_id),
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
                "updatedAt": (
                    str(row["updated_at"]) if row["updated_at"] else None
                ),
            }
        )
    return result
