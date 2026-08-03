"""项目与会话的 SQLite 仓储。"""

from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from backend.schemas.common import StoredMessage
from backend.schemas.workspace import ChatSession, WorkspaceProject, WorkspaceResponse
from backend.services.workspace.database import (
    dumps_json,
    loads_json,
    normalize_root_path,
    open_database,
    utc_now_iso,
)


def _project_from_row(row: object) -> WorkspaceProject:
    """把 SQLite 行转换成前端需要的项目对象。"""

    mapping = dict(row)  # type: ignore[arg-type]
    return WorkspaceProject.model_validate(
        {
            "id": mapping["id"],
            "name": mapping["name"],
            "rootPath": mapping["root_path"],
            "indexStatus": mapping["index_status"],
            "indexedFileCount": mapping["indexed_file_count"],
            "lastOpenedAt": mapping["last_opened_at"],
        }
    )


def _session_from_row(row: object) -> ChatSession:
    """把 SQLite 行转换成前端需要的会话对象。"""

    mapping = dict(row)  # type: ignore[arg-type]
    raw_messages = loads_json(mapping["messages_json"], [])
    messages = [StoredMessage.model_validate(item) for item in raw_messages]
    return ChatSession.model_validate(
        {
            "id": mapping["id"],
            "title": mapping["title"],
            "messages": messages,
            "mode": mapping["mode"],
            "projectId": mapping["project_id"],
            "updatedAt": mapping["updated_at"],
        }
    )


async def list_workspace(
    *, include_code: bool, include_commerce: bool, include_media: bool = False
) -> WorkspaceResponse:
    """读取项目列表和按插件开关筛选后的会话列表。"""

    allowed_modes = ["qa"]
    if include_code:
        allowed_modes.append("code")
    if include_commerce:
        allowed_modes.append("commerce")
    if include_media:
        allowed_modes.append("media")

    placeholders = ",".join("?" for _ in allowed_modes)
    async with open_database() as connection:
        project_cursor = await connection.execute(
            "SELECT * FROM projects ORDER BY last_opened_at DESC"
        )
        session_cursor = await connection.execute(
            f"SELECT * FROM sessions WHERE mode IN ({placeholders}) "
            "ORDER BY updated_at DESC",
            allowed_modes,
        )
        projects = [_project_from_row(row) for row in await project_cursor.fetchall()]
        sessions = [_session_from_row(row) for row in await session_cursor.fetchall()]
    return WorkspaceResponse(projects=projects, sessions=sessions)


async def create_project(root_path: str) -> WorkspaceProject:
    """创建或恢复一个本地项目记录。"""

    root = normalize_root_path(root_path)
    now = utc_now_iso()
    async with open_database() as connection:
        existing_cursor = await connection.execute(
            "SELECT * FROM projects WHERE root_path = ?", (str(root),)
        )
        existing = await existing_cursor.fetchone()
        if existing:
            await connection.execute(
                "UPDATE projects SET last_opened_at = ? WHERE id = ?",
                (now, existing["id"]),
            )
            updated = dict(existing)
            updated["last_opened_at"] = now
            return _project_from_row(updated)

        project_id = f"project_{uuid4().hex}"
        await connection.execute(
            "INSERT INTO projects "
            "(id, name, root_path, index_status, indexed_file_count, last_opened_at) "
            "VALUES (?, ?, ?, 'idle', 0, ?)",
            (project_id, root.name or str(root), str(root), now),
        )
    return WorkspaceProject.model_validate(
        {
            "id": project_id,
            "name": root.name or str(root),
            "rootPath": str(root),
            "indexStatus": "idle",
            "indexedFileCount": 0,
            "lastOpenedAt": now,
        }
    )


async def get_project(project_id: str) -> WorkspaceProject:
    """按项目 ID 读取项目；不存在时抛出易理解的错误。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT * FROM projects WHERE id = ?", (project_id,)
        )
        row = await cursor.fetchone()
    if not row:
        raise ValueError("当前 Code 会话绑定的项目不存在，请重新选择项目。")
    return _project_from_row(row)


async def create_session(
    *, mode: str, project_id: str | None, title: str, messages: list[StoredMessage]
) -> ChatSession:
    """创建一个新会话并保存初始欢迎消息。"""

    if mode == "code" and not project_id:
        raise ValueError("Code 会话必须绑定项目")
    session_id = f"session_{uuid4().hex}"
    now = utc_now_iso()
    payload = [message.model_dump(by_alias=True, exclude_none=True) for message in messages]
    async with open_database() as connection:
        await connection.execute(
            "INSERT INTO sessions "
            "(id, title, mode, project_id, messages_json, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (session_id, title or "新对话", mode, project_id, dumps_json(payload), now),
        )
    return ChatSession.model_validate(
        {
            "id": session_id,
            "title": title or "新对话",
            "messages": messages,
            "mode": mode,
            "projectId": project_id,
            "updatedAt": now,
        }
    )


async def update_session(
    *, session_id: str, title: str, messages: list[StoredMessage]
) -> ChatSession:
    """覆盖更新一个会话的标题和消息历史。"""

    now = utc_now_iso()
    payload = [message.model_dump(by_alias=True, exclude_none=True) for message in messages]
    async with open_database() as connection:
        cursor = await connection.execute(
            "UPDATE sessions SET title = ?, messages_json = ?, updated_at = ? "
            "WHERE id = ?",
            (title or "新对话", dumps_json(payload), now, session_id),
        )
        if cursor.rowcount == 0:
            raise ValueError("要更新的会话不存在")
        read_cursor = await connection.execute(
            "SELECT * FROM sessions WHERE id = ?", (session_id,)
        )
        row = await read_cursor.fetchone()
    if not row:
        raise ValueError("更新会话后读取失败")
    return _session_from_row(row)


async def delete_session(session_id: str) -> None:
    """删除指定会话。"""

    async with open_database() as connection:
        await connection.execute(
            "DELETE FROM agent_checkpoints WHERE session_id = ?",
            (session_id,),
        )
        await connection.execute("DELETE FROM sessions WHERE id = ?", (session_id,))


async def update_project_index_state(
    project_id: str, *, status: str, file_count: int | None = None
) -> None:
    """更新项目索引状态和文件数量。"""

    async with open_database() as connection:
        if file_count is None:
            await connection.execute(
                "UPDATE projects SET index_status = ? WHERE id = ?",
                (status, project_id),
            )
        else:
            await connection.execute(
                "UPDATE projects SET index_status = ?, indexed_file_count = ? "
                "WHERE id = ?",
                (status, file_count, project_id),
            )


async def resolve_project_root(project_id: str) -> Path:
    """根据项目 ID 返回可信的本地工作目录。"""

    project = await get_project(project_id)
    return Path(project.root_path).resolve()
