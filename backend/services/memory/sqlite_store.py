"""基于项目现有 SQLite 的 Memory Store 实现。"""

from __future__ import annotations

import logging
from typing import Any
from uuid import uuid4

from backend.services.memory.contracts import MemoryRecord
from backend.services.workspace.database import (
    dumps_json,
    loads_json,
    open_database,
    rebuild_memory_fts,
    utc_now_iso,
)

LOGGER = logging.getLogger(__name__)


class SQLiteMemoryStore:
    """为一种固定 Memory 类型提供持久化保存和检索。"""

    def __init__(self, memory_type: str) -> None:
        """保存 Memory 类型；表结构由数据库初始化阶段统一创建。"""

        self.memory_type = memory_type

    async def search(
        self,
        *,
        query: str,
        scope_ids: tuple[str, ...],
        top_k: int,
    ) -> list[MemoryRecord]:
        """使用 SQLite LIKE 在指定作用域内检索最近记忆。"""

        limit = max(1, min(top_k, 50))
        scopes = tuple(dict.fromkeys((*scope_ids, "global"))) or ("global",)
        placeholders = ",".join("?" for _ in scopes)
        normalized_query = query.strip()

        # 空查询用于加载最近任务状态；有查询时同时匹配内容和 metadata JSON。
        search_clause = ""
        parameters: list[object] = [self.memory_type, *scopes, utc_now_iso()]
        if normalized_query:
            search_clause = "AND (content LIKE ? OR metadata_json LIKE ?)"
            pattern = f"%{normalized_query[:500]}%"
            parameters.extend([pattern, pattern])
        parameters.append(limit)

        async with open_database() as connection:
            cursor = await connection.execute(
                f"""
                SELECT * FROM agent_memories
                WHERE memory_type = ?
                  AND scope_id IN ({placeholders})
                  AND (expires_at IS NULL OR expires_at > ?)
                  {search_clause}
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                tuple(parameters),
            )
            rows = await cursor.fetchall()
        return [self._from_row(row) for row in rows]

    async def save(
        self,
        *,
        scope_id: str,
        content: str,
        metadata: dict[str, Any] | None = None,
        expires_at: str | None = None,
    ) -> MemoryRecord:
        """保存一条非空记忆，并限制单条内容大小。"""

        normalized_scope = scope_id.strip() or "global"
        normalized_content = content.strip()
        if not normalized_content:
            raise ValueError("Memory 内容不能为空")
        if len(normalized_content) > 200_000:
            raise ValueError("单条 Memory 内容超过 200000 字符限制")

        identifier = f"mem_{uuid4().hex}"
        now = utc_now_iso()
        async with open_database() as connection:
            cursor = await connection.execute(
                """
                INSERT INTO agent_memories(
                    id, memory_type, scope_id, content, metadata_json,
                    created_at, updated_at, expires_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identifier,
                    self.memory_type,
                    normalized_scope,
                    normalized_content,
                    dumps_json(metadata or {}),
                    now,
                    now,
                    expires_at,
                ),
            )
            rowid = cursor.lastrowid
            if rowid is not None:
                try:
                    await connection.execute(
                        """
                        INSERT INTO agent_memories_fts(rowid, content, memory_type, scope_id)
                        VALUES (?, ?, ?, ?)
                        """,
                        (rowid, normalized_content, self.memory_type, normalized_scope),
                    )
                except Exception:
                    # FTS 索引失败不应阻断记忆写入；后续重建可恢复。
                    LOGGER.exception("记忆 FTS 索引写入失败")
        return MemoryRecord(
            id=identifier,
            memory_type=self.memory_type,
            scope_id=normalized_scope,
            content=normalized_content,
            metadata=dict(metadata or {}),
            created_at=now,
            updated_at=now,
            expires_at=expires_at,
        )

    async def delete_scope(self, scope_id: str) -> int:
        """删除指定作用域的当前 Memory 类型，供项目清理或测试使用。"""

        async with open_database() as connection:
            cursor = await connection.execute(
                "DELETE FROM agent_memories WHERE memory_type = ? AND scope_id = ?",
                (self.memory_type, scope_id),
            )
        try:
            await rebuild_memory_fts()
        except Exception:
            LOGGER.exception("记忆 FTS 索引重建失败")
        return max(0, cursor.rowcount)

    def _from_row(self, row: Any) -> MemoryRecord:
        """把 SQLite 行转换成不可变 MemoryRecord。"""

        metadata = loads_json(str(row["metadata_json"]), {})
        return MemoryRecord(
            id=str(row["id"]),
            memory_type=str(row["memory_type"]),
            scope_id=str(row["scope_id"]),
            content=str(row["content"]),
            metadata=dict(metadata) if isinstance(metadata, dict) else {},
            created_at=str(row["created_at"]),
            updated_at=str(row["updated_at"]),
            expires_at=str(row["expires_at"]) if row["expires_at"] else None,
        )
