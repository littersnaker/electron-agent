"""SQLite 数据库初始化与轻量异步兼容封装。

项目的数据量主要是本地会话、文件索引和 Agent Trace。为减少初学者需要安装的依赖，
本模块直接使用 Python 标准库 ``sqlite3``，再提供与原仓储代码一致的 ``await`` 接口。
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from backend.core.config import get_settings


SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root_path TEXT NOT NULL UNIQUE,
    index_status TEXT NOT NULL DEFAULT 'idle',
    indexed_file_count INTEGER NOT NULL DEFAULT 0,
    last_opened_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    mode TEXT NOT NULL,
    project_id TEXT,
    messages_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS file_index (
    project_id TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    content TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at REAL NOT NULL,
    PRIMARY KEY(project_id, relative_path),
    FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS pending_actions (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    action_json TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    model TEXT NOT NULL,
    request_preview TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    duration_ms INTEGER,
    error_message TEXT
);

CREATE TABLE IF NOT EXISTS trace_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trace_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL,
    duration_ms INTEGER,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY(trace_id) REFERENCES traces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS app_preferences (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS custom_models (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    base_url TEXT,
    include_in_auto INTEGER NOT NULL DEFAULT 1,
    auto_priority INTEGER NOT NULL DEFAULT 10,
    supports_vision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_kind TEXT NOT NULL,
    route TEXT NOT NULL,
    status TEXT NOT NULL,
    resumable INTEGER NOT NULL DEFAULT 1,
    request_json TEXT NOT NULL,
    state_json TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_agent_checkpoints_session_updated
ON agent_checkpoints(session_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS agent_memories (
      id TEXT PRIMARY KEY,
      memory_type TEXT NOT NULL,
      scope_id TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT
  );
  
  CREATE INDEX IF NOT EXISTS idx_agent_memories_lookup
  ON agent_memories(memory_type, scope_id, updated_at DESC);

  CREATE TABLE IF NOT EXISTS project_completed_works (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      title_key TEXT NOT NULL,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      acceptance_json TEXT NOT NULL DEFAULT '[]',
      target_files_json TEXT NOT NULL DEFAULT '[]',
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 100,
      completed_at TEXT NOT NULL
  );
  
  CREATE INDEX IF NOT EXISTS idx_completed_works_lookup
  ON project_completed_works(project_id, title_key, completed_at DESC);

  CREATE TABLE IF NOT EXISTS review_artifacts (
      id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      agent_kind TEXT NOT NULL DEFAULT 'code',
      scope_id TEXT NOT NULL DEFAULT 'project',
      model TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      digest_hash TEXT NOT NULL,
      output_json TEXT NOT NULL,
      error_message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      reviewed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_review_artifacts_work
  ON review_artifacts(work_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_review_artifacts_status
  ON review_artifacts(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS memory_eval (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      injected INTEGER NOT NULL DEFAULT 0,
      hit INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memory_eval_created
  ON memory_eval(created_at DESC);

  CREATE VIRTUAL TABLE IF NOT EXISTS agent_memories_fts USING fts5(
      content,
      memory_type UNINDEXED,
      scope_id UNINDEXED
  );

  DROP TRIGGER IF EXISTS trg_agent_memories_fts_insert;
  DROP TRIGGER IF EXISTS trg_agent_memories_fts_delete;
  DROP TRIGGER IF EXISTS trg_agent_memories_fts_update;

  INSERT INTO agent_memories_fts(rowid, content, memory_type, scope_id)
  SELECT rowid, content, memory_type, scope_id FROM agent_memories
  WHERE NOT EXISTS (SELECT 1 FROM agent_memories_fts);

  CREATE TABLE IF NOT EXISTS listing_drafts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',
      query TEXT NOT NULL,
      marketplace TEXT NOT NULL DEFAULT 'US',
      draft_json TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'template',
      status TEXT NOT NULL DEFAULT 'pending',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      confirmed_at TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_listing_drafts_status
  ON listing_drafts(status, created_at DESC);

  CREATE TABLE IF NOT EXISTS installed_skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL DEFAULT '0.0.0',
      description TEXT NOT NULL DEFAULT '',
      source_url TEXT NOT NULL DEFAULT '',
      source_format TEXT NOT NULL DEFAULT 'skill-md',
      content_json TEXT NOT NULL,
      files_json TEXT NOT NULL DEFAULT '{}',
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
  );
  """


class AsyncCursor:
    """把 ``sqlite3.Cursor`` 包装成仓储层可 ``await`` 的游标。"""

    def __init__(self, cursor: sqlite3.Cursor) -> None:
        """保存底层同步游标。"""

        self._cursor = cursor
        self.rowcount = cursor.rowcount

    async def fetchone(self) -> sqlite3.Row | None:
        """读取一行查询结果。"""

        return self._cursor.fetchone()

    async def fetchall(self) -> list[sqlite3.Row]:
        """读取全部查询结果。"""

        return self._cursor.fetchall()

    @property
    def lastrowid(self) -> int | None:
        """返回最近一次 INSERT 的 rowid。"""

        return self._cursor.lastrowid


class AsyncConnection:
    """为本地 SQLite 连接提供简单的异步外观。"""

    def __init__(self, connection: sqlite3.Connection) -> None:
        """保存底层连接。"""

        self._connection = connection

    async def execute(
        self, sql: str, parameters: Iterable[Any] = ()
    ) -> AsyncCursor:
        """执行单条 SQL 并返回异步游标。"""

        return AsyncCursor(self._connection.execute(sql, tuple(parameters)))

    async def executemany(
        self, sql: str, parameter_rows: Iterable[Iterable[Any]]
    ) -> AsyncCursor:
        """批量执行同一条 SQL。"""

        rows = [tuple(row) for row in parameter_rows]
        return AsyncCursor(self._connection.executemany(sql, rows))

    async def executescript(self, sql: str) -> AsyncCursor:
        """执行包含多条语句的初始化脚本。"""

        return AsyncCursor(self._connection.executescript(sql))

    async def commit(self) -> None:
        """提交当前事务。"""

        self._connection.commit()

    async def rollback(self) -> None:
        """回滚当前事务。"""

        self._connection.rollback()

    async def close(self) -> None:
        """关闭数据库连接。"""

        self._connection.close()


def utc_now_iso() -> str:
    """返回带时区的 UTC ISO 时间字符串。"""

    return datetime.now(UTC).isoformat()


@asynccontextmanager
async def open_database() -> AsyncIterator[AsyncConnection]:
    """打开一个自动提交、异常回滚并自动关闭的 SQLite 连接。"""

    database_path = get_settings().database_path
    database_path.parent.mkdir(parents=True, exist_ok=True)
    raw_connection = sqlite3.connect(database_path, timeout=30.0)
    raw_connection.row_factory = sqlite3.Row
    raw_connection.execute("PRAGMA foreign_keys=ON")
    connection = AsyncConnection(raw_connection)
    try:
        yield connection
        await connection.commit()
    except Exception:
        await connection.rollback()
        raise
    finally:
        await connection.close()


async def initialize_database() -> None:
    """创建应用所需的数据表。"""

    async with open_database() as connection:
        await connection.executescript(SCHEMA_SQL)


def dumps_json(value: object) -> str:
    """把 Python 对象序列化为可读的 UTF-8 JSON 字符串。"""

    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def loads_json(value: str, default: object) -> object:
    """安全解析数据库 JSON；解析失败时返回默认值。"""

    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


async def rebuild_memory_fts() -> None:
    """整体重建记忆 FTS 索引（删除/淘汰后调用，保证索引一致）。"""

    async with open_database() as connection:
        await connection.execute("DELETE FROM agent_memories_fts")
        await connection.execute(
            """
            INSERT INTO agent_memories_fts(rowid, content, memory_type, scope_id)
            SELECT rowid, content, memory_type, scope_id FROM agent_memories
            """
        )


def normalize_root_path(raw_path: str) -> Path:
    """把用户选择的项目目录转换为已存在的绝对目录。"""

    path = Path(raw_path).expanduser().resolve()
    if not path.is_dir():
        raise ValueError(f"项目目录不存在或不是文件夹：{path}")
    return path
