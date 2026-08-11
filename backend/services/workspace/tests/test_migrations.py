"""数据库版本化迁移机制测试：建库、增量应用、幂等与回填。"""

from __future__ import annotations

import asyncio

from backend.core.config import get_settings
from backend.services.workspace.database import (
    SCHEMA_SQL,
    initialize_database,
    open_database,
)
from backend.services.workspace.migrations import (
    MIGRATIONS_DIR,
    apply_migrations,
)


async def _column_names(connection, table: str) -> set[str]:
    cursor = await connection.execute(f"PRAGMA table_info({table})")
    rows = await cursor.fetchall()
    return {str(row[1]) for row in rows}


async def _applied_versions() -> list[str]:
    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        )
        rows = await cursor.fetchall()
    return [str(row["version"]) for row in rows]


def _isolated_db(monkeypatch, tmp_path) -> None:
    """把数据目录指向临时目录并清空 Settings 缓存。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()


def test_apply_migrations_adds_listing_drafts_updated_at(
    monkeypatch, tmp_path
) -> None:
    """全新库：基线建表后迁移应补齐 updated_at 列。"""

    _isolated_db(monkeypatch, tmp_path)
    asyncio.run(initialize_database())
    try:
        # initialize_database 内部已应用迁移，重复应用应无新增。
        assert asyncio.run(apply_migrations()) == []

        async def check() -> None:
            async with open_database() as connection:
                columns = await _column_names(connection, "listing_drafts")
                assert "updated_at" in columns
                assert "created_at" in columns

        asyncio.run(check())
    finally:
        get_settings.cache_clear()


def test_apply_migrations_is_idempotent(monkeypatch, tmp_path) -> None:
    """重复应用迁移不重复执行，版本表只保留一份记录。"""

    _isolated_db(monkeypatch, tmp_path)
    asyncio.run(initialize_database())
    try:
        assert asyncio.run(apply_migrations()) == []
        assert asyncio.run(apply_migrations()) == []
        versions = asyncio.run(_applied_versions())
        assert versions == sorted(path.stem for path in MIGRATIONS_DIR.glob("*.sql"))
    finally:
        get_settings.cache_clear()


def test_apply_migrations_backfills_existing_rows(monkeypatch, tmp_path) -> None:
    """旧库数据：迁移应把历史行 updated_at 回填为 created_at。"""

    _isolated_db(monkeypatch, tmp_path)
    created_at = "2026-08-01T10:00:00+00:00"

    async def setup() -> None:
        async with open_database() as connection:
            await connection.executescript(SCHEMA_SQL)
            await connection.execute(
                """
                INSERT INTO listing_drafts(
                    id, session_id, query, marketplace, draft_json, source,
                    status, notes, created_at, confirmed_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending', '', ?, NULL)
                """,
                (
                    "draft_legacy",
                    "session-1",
                    "yoga mat",
                    "US",
                    '{"title":"Legacy"}',
                    "template",
                    created_at,
                ),
            )
        await apply_migrations()

    async def check() -> None:
        async with open_database() as connection:
            cursor = await connection.execute(
                "SELECT created_at, updated_at FROM listing_drafts WHERE id = ?",
                ("draft_legacy",),
            )
            row = await cursor.fetchone()
            assert row is not None
            assert str(row["updated_at"]) == created_at

    try:
        asyncio.run(setup())
        asyncio.run(check())
    finally:
        get_settings.cache_clear()
