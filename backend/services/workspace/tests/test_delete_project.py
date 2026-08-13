"""项目删除测试：级联清理各关联表。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.core.config import get_settings
from backend.services.workspace.database import initialize_database
from backend.services.workspace.repository import (
    create_project,
    create_session,
    delete_project,
)


@pytest.mark.asyncio
async def test_delete_project_removes_related_rows(tmp_path: Path, monkeypatch) -> None:
    """删除项目应清空 sessions/checkpoints/completed_works/traces 等关联数据。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    await initialize_database()

    project_root = tmp_path / "demo-project"
    project_root.mkdir()
    project = await create_project(str(project_root))
    project_id = project.id
    session = await create_session(
        mode="code",
        project_id=project_id,
        title="测试会话",
        messages=[],
    )

    # 手动插入关联数据，验证删除覆盖。
    from backend.services.workspace.database import open_database

    async with open_database() as connection:
        await connection.execute(
            "INSERT INTO project_completed_works "
            "(project_id, work_id, title_key, title, objective, acceptance_json, "
            "target_files_json, changed_files_json, priority, completed_at) "
            "VALUES (?, 'w1', 'k1', 't', 'o', '[]', '[]', '[]', 1, '2026-01-01')",
            (project_id,),
        )
        await connection.execute(
            "INSERT INTO traces (id, session_id, project_id, model, request_preview, "
            "status, started_at) VALUES ('tr1', ?, ?, 'm', 'preview', 'done', '2026-01-01')",
            (session.id, project_id),
        )

    await delete_project(project_id)

    async with open_database() as connection:
        project_row = await (await connection.execute(
            "SELECT id FROM projects WHERE id = ?", (project_id,)
        )).fetchone()
        session_row = await (await connection.execute(
            "SELECT id FROM sessions WHERE project_id = ?", (project_id,)
        )).fetchone()
        completed_row = await (await connection.execute(
            "SELECT id FROM project_completed_works WHERE project_id = ?",
            (project_id,),
        )).fetchone()
        trace_row = await (await connection.execute(
            "SELECT id FROM traces WHERE project_id = ?", (project_id,)
        )).fetchone()

    assert project_row is None
    assert session_row is None
    assert completed_row is None
    assert trace_row is None
