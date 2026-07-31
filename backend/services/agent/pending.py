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
