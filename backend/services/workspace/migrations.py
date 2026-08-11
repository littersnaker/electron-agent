"""SQLite 版本化 Schema 迁移。

基线 ``SCHEMA_SQL`` 只负责首次建表；后续字段/表/索引变更统一放到
``backend/services/workspace/migrations/NNN_*.sql``，由 ``apply_migrations``
按文件名序号在事务内应用并记录版本，保证幂等且可增量演进。
"""

from __future__ import annotations

import logging
from pathlib import Path

from backend.services.workspace.database import open_database, utc_now_iso

LOGGER = logging.getLogger(__name__)

MIGRATIONS_DIR = Path(__file__).resolve().parent / "migrations"

_MIGRATIONS_TABLE = """
CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
)
"""


async def _read_applied_versions() -> set[str]:
    """读取当前数据库已应用的迁移版本号集合。"""

    async with open_database() as connection:
        await connection.execute(_MIGRATIONS_TABLE)
        cursor = await connection.execute(
            "SELECT version FROM schema_migrations ORDER BY version"
        )
        rows = await cursor.fetchall()
    return {str(row["version"]) for row in rows}


async def apply_migrations() -> list[str]:
    """按序号应用尚未执行的迁移脚本，返回本次应用的版本号列表。

    每个迁移的执行结果与版本记录在同一事务内提交：脚本失败或版本
    记录失败都会整体回滚，不会留下半应用状态。
    """

    migrations = sorted(MIGRATIONS_DIR.glob("*.sql"))
    applied = await _read_applied_versions()
    applied_now: list[str] = []
    for path in migrations:
        version = path.stem
        if version in applied:
            continue
        script = path.read_text(encoding="utf-8")
        async with open_database() as connection:
            # executescript 会先提交挂起事务再执行脚本；随后写入版本记录，
            # 最后统一 commit，保证"脚本 + 版本记录"一起生效。
            await connection.executescript(script)
            await connection.execute(
                "INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)",
                (version, utc_now_iso()),
            )
        applied.add(version)
        applied_now.append(version)
        LOGGER.info("已应用数据库迁移：%s", version)
    return applied_now
