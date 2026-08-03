"""所有 Agent 共用的 SQLite Checkpoint 仓储。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import uuid4

from backend.services.workspace.database import (
    dumps_json,
    loads_json,
    open_database,
    utc_now_iso,
)

ACTIVE_STATUSES = {"running", "paused", "interrupted", "failed"}


@dataclass(slots=True)
class AgentCheckpoint:
    """一条可恢复的 Agent 执行快照。"""

    id: str
    session_id: str
    agent_kind: str
    route: str
    status: str
    resumable: bool
    request: dict[str, Any]
    state: dict[str, Any]
    label: str
    error_message: str
    created_at: str
    updated_at: str
    completed_at: str | None = None

    def to_json(self) -> dict[str, Any]:
        """转换成前端稳定 JSON。"""

        return {
            "id": self.id,
            "sessionId": self.session_id,
            "agentKind": self.agent_kind,
            "route": self.route,
            "status": self.status,
            "resumable": self.resumable,
            "request": self.request,
            "state": self.state,
            "label": self.label,
            "errorMessage": self.error_message,
            "createdAt": self.created_at,
            "updatedAt": self.updated_at,
            "completedAt": self.completed_at,
        }


def _from_row(row: Any) -> AgentCheckpoint:
    """把 SQLite 行转换成 Checkpoint。"""

    return AgentCheckpoint(
        id=str(row["id"]),
        session_id=str(row["session_id"]),
        agent_kind=str(row["agent_kind"]),
        route=str(row["route"]),
        status=str(row["status"]),
        resumable=bool(row["resumable"]),
        request=loads_json(str(row["request_json"]), {}),
        state=loads_json(str(row["state_json"]), {}),
        label=str(row["label"]),
        error_message=str(row["error_message"]),
        created_at=str(row["created_at"]),
        updated_at=str(row["updated_at"]),
        completed_at=str(row["completed_at"]) if row["completed_at"] else None,
    )


async def create_checkpoint(
    *,
    session_id: str,
    agent_kind: str,
    route: str,
    request: dict[str, Any],
    label: str = "",
    checkpoint_id: str = "",
) -> AgentCheckpoint:
    """创建运行中快照；同一会话旧运行快照会保留用于审计。"""

    now = utc_now_iso()
    identifier = checkpoint_id.strip() or f"cp_{uuid4().hex}"
    async with open_database() as connection:
        await connection.execute(
            """
            INSERT OR REPLACE INTO agent_checkpoints(
                id, session_id, agent_kind, route, status, resumable,
                request_json, state_json, label, error_message,
                created_at, updated_at, completed_at
            ) VALUES (?, ?, ?, ?, 'running', 1, ?, '{}', ?, '', ?, ?, NULL)
            """,
            (
                identifier,
                session_id,
                agent_kind,
                route,
                dumps_json(request),
                label[:240],
                now,
                now,
            ),
        )
    checkpoint = await get_checkpoint(identifier)
    if checkpoint is None:
        raise RuntimeError("Checkpoint 创建后无法读取")
    return checkpoint


async def get_checkpoint(checkpoint_id: str) -> AgentCheckpoint | None:
    """按 ID 读取快照。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT * FROM agent_checkpoints WHERE id = ?",
            (checkpoint_id,),
        )
        row = await cursor.fetchone()
    return _from_row(row) if row else None


async def get_latest_resumable(session_id: str) -> AgentCheckpoint | None:
    """读取会话最近一条未完成且允许恢复的快照。"""

    placeholders = ",".join("?" for _ in ACTIVE_STATUSES)
    parameters = (session_id, *sorted(ACTIVE_STATUSES))
    async with open_database() as connection:
        cursor = await connection.execute(
            f"""
            SELECT * FROM agent_checkpoints
            WHERE session_id = ? AND resumable = 1
              AND status IN ({placeholders})
            ORDER BY updated_at DESC LIMIT 1
            """,
            parameters,
        )
        row = await cursor.fetchone()
    return _from_row(row) if row else None


async def update_checkpoint(
    checkpoint_id: str,
    *,
    status: str | None = None,
    state: dict[str, Any] | None = None,
    request: dict[str, Any] | None = None,
    error_message: str | None = None,
    resumable: bool | None = None,
) -> AgentCheckpoint | None:
    """局部更新快照，不覆盖未提供的字段。"""

    current = await get_checkpoint(checkpoint_id)
    if current is None:
        return None
    next_status = status or current.status
    completed_at = utc_now_iso() if next_status in {"completed", "discarded"} else None
    async with open_database() as connection:
        await connection.execute(
            """
            UPDATE agent_checkpoints
            SET status = ?, resumable = ?, request_json = ?, state_json = ?,
                error_message = ?, updated_at = ?, completed_at = ?
            WHERE id = ?
            """,
            (
                next_status,
                int(current.resumable if resumable is None else resumable),
                dumps_json(current.request if request is None else request),
                dumps_json(current.state if state is None else state),
                current.error_message if error_message is None else error_message[:4000],
                utc_now_iso(),
                completed_at,
                checkpoint_id,
            ),
        )
    return await get_checkpoint(checkpoint_id)


async def delete_checkpoint(checkpoint_id: str) -> bool:
    """永久删除用户明确放弃的快照。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "DELETE FROM agent_checkpoints WHERE id = ?",
            (checkpoint_id,),
        )
    return cursor.rowcount > 0
