"""Code Agent 待批准文件修改的保存与恢复模块。"""

from __future__ import annotations

import re
from typing import Any

from backend.services.workspace.database import dumps_json, loads_json, open_database, utc_now_iso


async def save_pending_action(
    *, request_id: str, session_id: str, project_id: str, action: dict[str, Any]
) -> None:
    """保存一组等待用户批准的文件修改。"""

    async with open_database() as connection:
        await connection.execute(
            "INSERT OR REPLACE INTO pending_actions "
            "(request_id, session_id, project_id, action_json, created_at) "
            "VALUES (?, ?, ?, ?, ?)",
            (request_id, session_id, project_id, dumps_json(action), utc_now_iso()),
        )


async def pop_pending_action(request_id: str) -> dict[str, Any] | None:
    """读取并删除指定待批准操作，防止重复执行。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT action_json FROM pending_actions WHERE request_id = ?",
            (request_id,),
        )
        row = await cursor.fetchone()
        if row:
            await connection.execute(
                "DELETE FROM pending_actions WHERE request_id = ?", (request_id,)
            )
    if not row:
        return None
    value = loads_json(row["action_json"], {})
    return value if isinstance(value, dict) else None


async def save_pending_command(
    *,
    request_id: str,
    session_id: str,
    work_id: str,
    command: str,
    checkpoint_id: str,
) -> None:
    """保存一条等待用户审批的命令（同 Work 旧记录先清掉，避免串台）。"""

    async with open_database() as connection:
        await connection.execute(
            "DELETE FROM pending_commands WHERE work_id = ?",
            (work_id,),
        )
        await connection.execute(
            "INSERT INTO pending_commands "
            "(request_id, session_id, work_id, command, status, checkpoint_id, "
            "created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)",
            (
                request_id,
                session_id,
                work_id,
                command,
                checkpoint_id,
                utc_now_iso(),
                utc_now_iso(),
            ),
        )


async def find_pending_command(work_id: str) -> dict[str, Any] | None:
    """按 Work 查询最新一条命令审批记录（含 pending/approved/rejected）。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT request_id, session_id, work_id, command, status, checkpoint_id "
            "FROM pending_commands WHERE work_id = ? "
            "ORDER BY created_at DESC LIMIT 1",
            (work_id,),
        )
        row = await cursor.fetchone()
    if not row:
        return None
    return {
        "requestId": str(row["request_id"]),
        "sessionId": str(row["session_id"]),
        "workId": str(row["work_id"]),
        "command": str(row["command"]),
        "status": str(row["status"]),
        "checkpointId": str(row["checkpoint_id"]),
    }


async def consume_pending_command(work_id: str, command: str) -> str | None:
    """读取并删除匹配命令的审批决定，返回 approved/rejected；不匹配返回 None。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT status FROM pending_commands "
            "WHERE work_id = ? AND command = ? AND status IN ('approved', 'rejected') "
            "ORDER BY created_at DESC LIMIT 1",
            (work_id, command),
        )
        row = await cursor.fetchone()
        if row:
            await connection.execute(
                "DELETE FROM pending_commands WHERE work_id = ? AND command = ?",
                (work_id, command),
            )
    if not row:
        return None
    return str(row["status"])


async def find_pending_command_by_request_id(
    request_id: str,
) -> dict[str, Any] | None:
    """按审批请求 ID 查询命令审批记录（供回复处理使用）。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT request_id, session_id, work_id, command, status, checkpoint_id "
            "FROM pending_commands WHERE request_id = ?",
            (request_id,),
        )
        row = await cursor.fetchone()
    if not row:
        return None
    return {
        "requestId": str(row["request_id"]),
        "sessionId": str(row["session_id"]),
        "workId": str(row["work_id"]),
        "command": str(row["command"]),
        "status": str(row["status"]),
        "checkpointId": str(row["checkpoint_id"]),
    }


async def resolve_pending_command(request_id: str, *, approved: bool) -> None:
    """写入用户对命令审批的决定（approve/reject）。"""

    async with open_database() as connection:
        await connection.execute(
            "UPDATE pending_commands SET status = ?, updated_at = ? "
            "WHERE request_id = ?",
            ("approved" if approved else "rejected", utc_now_iso(), request_id),
        )


def parse_interactive_reply(text: str) -> tuple[str, str, str | None]:
    """解析前端生成的 ``[INTERACTIVE_REPLY]`` 控制消息。"""

    match = re.search(
        r"^\[INTERACTIVE_REPLY\]\s+id=([^\s]+)\s+mode=([^\s]+)(?:\s+answer=(.*))?$",
        text.strip(),
        re.IGNORECASE,
    )
    if not match:
        raise ValueError("交互回复格式无效，请重新点击批准或拒绝。")
    request_id, mode, answer = match.groups()
    return request_id, mode.lower(), answer
