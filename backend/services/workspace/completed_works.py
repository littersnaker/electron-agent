"""项目级“已完成 Work 注册表”。

Work 真正成功落盘后登记到 SQLite；下次 Planner 生成相同标题的 Work 时，
如果登记产物文件仍然存在，直接标记跳过，不再交给模型重复执行。
这是确定性机制，不依赖模型判断，避免“组件做过了又重跑”的 Token 浪费。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from backend.services.agent.work_models import WorkLedger
from backend.services.workspace.database import (
    dumps_json,
    loads_json,
    open_database,
    utc_now_iso,
)

_REDO_TERMS = (
    "重新",
    "重做",
    "覆盖",
    "再来",
    "再次",
    "换一种",
    "推翻",
    "重新生成",
    "rework",
    "regenerate",
)


def title_key(title: str) -> str:
    """生成稳定标题键：去掉空白、标点和分隔符后小写。"""

    return re.sub(r"[\s\-_·.,，。、:：;；()（）/\\\[\]{}]+", "", str(title or "").lower())


async def record_completed_works(
    project_id: str,
    items: list[dict[str, Any]],
) -> int:
    """把一次运行中 succeeded 的 Work 登记到项目注册表。"""

    normalized_project = project_id.strip()
    if not normalized_project:
        return 0
    now = utc_now_iso()
    rows: list[tuple[object, ...]] = []
    for item in items:
        if not isinstance(item, dict) or item.get("status") != "succeeded":
            continue
        title = str(item.get("title") or "").strip()
        if not title:
            continue
        rows.append(
            (
                normalized_project,
                str(item.get("id") or ""),
                title_key(title),
                title,
                str(item.get("objective") or "")[:4_000],
                dumps_json(item.get("acceptanceCriteria") or []),
                dumps_json(item.get("targetFiles") or []),
                dumps_json(item.get("changedFiles") or []),
                int(item.get("priority") or 100),
                now,
            )
        )
    if not rows:
        return 0
    async with open_database() as connection:
        await connection.executemany(
            """
            INSERT INTO project_completed_works(
                project_id, work_id, title_key, title, objective,
                acceptance_json, target_files_json, changed_files_json,
                priority, completed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
    return len(rows)


async def _latest_completed_row(
    project_id: str,
    key: str,
) -> dict[str, Any] | None:
    """读取项目内同一标题键最近一次成功记录。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            """
            SELECT changed_files_json, target_files_json, completed_at, title
            FROM project_completed_works
            WHERE project_id = ? AND title_key = ?
            ORDER BY completed_at DESC LIMIT 1
            """,
            (project_id, key),
        )
        row = await cursor.fetchone()
    if row is None:
        return None
    return {
        "changedFiles": loads_json(str(row["changed_files_json"]), []),
        "targetFiles": loads_json(str(row["target_files_json"]), []),
        "completedAt": str(row["completed_at"]),
        "title": str(row["title"]),
    }


def _files_exist(root: Path, paths: list[object]) -> bool:
    """判断登记产物是否仍然全部存在；任何缺失都不允许跳过。"""

    if not paths:
        return False
    for raw in paths:
        relative = str(raw or "").strip().replace("\\", "/").strip("/")
        if not relative or relative.startswith("@"):
            continue
        if not (root / relative).is_file():
            return False
    return True


async def skip_redundant_works(
    *,
    root: Path,
    project_id: str,
    ledger: WorkLedger,
) -> int:
    """把注册表里已完成、且产物仍在磁盘上的待办 Work 标记为跳过。"""

    normalized_project = project_id.strip()
    if not normalized_project:
        return 0
    skipped = 0
    for item in ledger.items:
        if item.status != "pending":
            continue
        if any(
            term in f"{item.title} {item.objective}"
            for term in _REDO_TERMS
        ):
            # 用户明确要求重做/覆盖时不得跳过。
            continue
        record = await _latest_completed_row(normalized_project, title_key(item.title))
        if record is None:
            continue
        changed = record.get("changedFiles") or []
        if not _files_exist(root, changed):
            # 已登记的产物被删除或从未落盘时不能跳过，交给 Worker 重新执行。
            continue
        ledger.skip(
            item.id,
            (
                f"该 Work 在 {record.get('completedAt')} 已完成过"
                f"（{len(changed)} 个产物文件仍存在），跳过重复执行。"
            ),
        )
        skipped += 1
    return skipped


__all__ = ["record_completed_works", "skip_redundant_works", "title_key"]
