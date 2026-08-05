"""会话搜索：FTS5 优先 + LIKE 回退，覆盖 agent_memories 全部类型。"""

from __future__ import annotations

from typing import Any

from backend.services.workspace.database import (
    loads_json,
    open_database,
)


def _fts_query(value: str) -> str:
    """把用户输入转成安全的 FTS5 MATCH 短语。"""

    cleaned = (value or "").strip().replace('"', " ")
    if not cleaned:
        return ""
    return f'"{cleaned}"'


async def _search_fts(
    query: str,
    scope_ids: tuple[str, ...],
    limit: int,
) -> list[dict[str, Any]]:
    """FTS5 全文检索（对路径/ASCII 关键词效果好）。"""

    phrase = _fts_query(query)
    if not phrase:
        return []
    scopes = tuple(dict.fromkeys((*scope_ids, "global"))) or ("global",)
    placeholders = ",".join("?" for _ in scopes)
    try:
        async with open_database() as connection:
            cursor = await connection.execute(
                f"""
                SELECT m.id, m.memory_type, m.scope_id, m.content,
                       m.created_at, m.updated_at, m.metadata_json,
                       snippet(agent_memories_fts, 0, '[', ']', '…', 12) AS highlight
                FROM agent_memories_fts
                JOIN agent_memories m ON m.rowid = agent_memories_fts.rowid
                WHERE agent_memories_fts MATCH ?
                  AND m.scope_id IN ({placeholders})
                ORDER BY bm25(agent_memories_fts)
                LIMIT ?
                """,
                (phrase, *scopes, limit),
            )
            rows = await cursor.fetchall()
    except Exception:
        return []
    result: list[dict[str, Any]] = []
    for row in rows:
        result.append(
            {
                "id": str(row["id"]),
                "memoryType": str(row["memory_type"]),
                "scopeId": str(row["scope_id"]),
                "content": str(row["content"]),
                "highlight": str(row["highlight"] or ""),
                "metadata": loads_json(str(row["metadata_json"]), {}),
                "createdAt": str(row["created_at"]),
                "updatedAt": str(row["updated_at"]),
            }
        )
    return result


async def _search_like(
    query: str,
    scope_ids: tuple[str, ...],
    limit: int,
) -> list[dict[str, Any]]:
    """LIKE 回退（对中文子串可靠）。"""

    scopes = tuple(dict.fromkeys((*scope_ids, "global"))) or ("global",)
    placeholders = ",".join("?" for _ in scopes)
    pattern = f"%{query.strip()[:500]}%"
    async with open_database() as connection:
        cursor = await connection.execute(
            f"""
            SELECT id, memory_type, scope_id, content, created_at,
                   updated_at, metadata_json
            FROM agent_memories
            WHERE scope_id IN ({placeholders})
              AND (content LIKE ? OR metadata_json LIKE ?)
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (*scopes, pattern, pattern, limit),
        )
        rows = await cursor.fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        result.append(
            {
                "id": str(row["id"]),
                "memoryType": str(row["memory_type"]),
                "scopeId": str(row["scope_id"]),
                "content": str(row["content"]),
                "highlight": "",
                "metadata": loads_json(str(row["metadata_json"]), {}),
                "createdAt": str(row["created_at"]),
                "updatedAt": str(row["updated_at"]),
            }
        )
    return result


async def session_search(
    *,
    query: str,
    scope_ids: tuple[str, ...] = (),
    limit: int = 20,
) -> dict[str, Any]:
    """统一会话搜索：FTS5 优先，命中不足时 LIKE 回退。"""

    normalized = (query or "").strip()
    if not normalized:
        return {"items": [], "engine": "none"}
    max_limit = max(1, min(limit, 50))
    fts_results = await _search_fts(normalized, scope_ids, max_limit)
    if fts_results:
        return {"items": fts_results, "engine": "fts5"}
    like_results = await _search_like(normalized, scope_ids, max_limit)
    return {"items": like_results, "engine": "like"}
