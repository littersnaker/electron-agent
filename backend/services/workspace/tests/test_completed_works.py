"""项目级已完成 Work 注册表的登记与跳过测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.core.config import get_settings
from backend.services.agent.planner.task_planner import WorkItem, WorkLedger
from backend.services.workspace.completed_works import (
    record_completed_works,
    skip_redundant_works,
    title_key,
)
from backend.services.workspace.database import initialize_database


def _isolate_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """把测试数据库隔离到临时目录。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "agent-data"))
    get_settings.cache_clear()


def _completed_item(
    *,
    title: str = "Apple 风格设计基座与共享 UI 组件",
    changed_files: list[str] | None = None,
    status: str = "succeeded",
) -> dict[str, object]:
    """构造一条注册表可识别的成功 Work 记录。"""

    files = changed_files if changed_files is not None else ["src/tokens.ts", "src/Button.tsx"]
    return {
        "id": "W002",
        "title": title,
        "objective": "建立设计 tokens 与基础组件",
        "status": status,
        "acceptanceCriteria": ["tokens 存在", "组件存在"],
        "targetFiles": list(files),
        "changedFiles": list(files),
        "priority": 10,
    }


def _pending_work(
    *,
    title: str = "Apple 风格设计基座与共享 UI 组件",
    objective: str = "建立设计 tokens 与基础组件",
    target_files: list[str] | None = None,
) -> WorkItem:
    """构造一个待执行的同标题 Work。"""

    files = target_files if target_files is not None else ["src/tokens.ts", "src/Button.tsx"]
    return WorkItem(
        id="W002",
        title=title,
        objective=objective,
        priority=10,
        target_files=files,
    )


@pytest.mark.asyncio
async def test_record_and_skip_reuses_completed_work(tmp_path, monkeypatch) -> None:
    """登记过且产物仍在磁盘上的同标题 Work 应被确定性跳过。"""

    _isolate_db(tmp_path, monkeypatch)
    await initialize_database()
    try:
        root = tmp_path / "project"
        root.mkdir()
        (root / "src").mkdir()
        (root / "src" / "tokens.ts").write_text("export const tokens = {}", encoding="utf-8")
        (root / "src" / "Button.tsx").write_text("export const Button = () => null", encoding="utf-8")

        assert await record_completed_works("project-1", [_completed_item()]) == 1
        ledger = WorkLedger([_pending_work()])

        skipped = await skip_redundant_works(root=root, project_id="project-1", ledger=ledger)

        assert skipped == 1
        assert ledger.items[0].status == "skipped"
        assert "已完成过" in ledger.items[0].summary
    finally:
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_skip_requires_all_artifacts_to_exist(tmp_path, monkeypatch) -> None:
    """产物被删除后不得跳过，必须重新执行。"""

    _isolate_db(tmp_path, monkeypatch)
    await initialize_database()
    try:
        root = tmp_path / "project"
        root.mkdir()
        (root / "src").mkdir()
        (root / "src" / "tokens.ts").write_text("x", encoding="utf-8")
        await record_completed_works("project-1", [_completed_item()])
        ledger = WorkLedger([_pending_work()])

        skipped = await skip_redundant_works(root=root, project_id="project-1", ledger=ledger)

        assert skipped == 0
        assert ledger.items[0].status == "pending"
    finally:
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_skip_requires_title_match(tmp_path, monkeypatch) -> None:
    """标题不同的 Work 不得误跳（用户可能要求继续修改）。"""

    _isolate_db(tmp_path, monkeypatch)
    await initialize_database()
    try:
        root = tmp_path / "project"
        root.mkdir()
        (root / "src").mkdir()
        (root / "src" / "tokens.ts").write_text("x", encoding="utf-8")
        (root / "src" / "Button.tsx").write_text("y", encoding="utf-8")
        await record_completed_works("project-1", [_completed_item()])
        ledger = WorkLedger(
            [_pending_work(title="继续优化 Apple 风格组件交互细节")]
        )

        skipped = await skip_redundant_works(root=root, project_id="project-1", ledger=ledger)

        assert skipped == 0
        assert ledger.items[0].status == "pending"
    finally:
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_skip_respects_explicit_redo_intent(tmp_path, monkeypatch) -> None:
    """用户明确要求重新生成/覆盖时，同标题 Work 不得被注册表跳过。"""

    _isolate_db(tmp_path, monkeypatch)
    await initialize_database()
    try:
        root = tmp_path / "project"
        root.mkdir()
        (root / "src").mkdir()
        (root / "src" / "tokens.ts").write_text("x", encoding="utf-8")
        (root / "src" / "Button.tsx").write_text("y", encoding="utf-8")
        await record_completed_works("project-1", [_completed_item()])
        ledger = WorkLedger(
            [
                _pending_work(
                    objective="重新生成 Apple 风格设计 tokens 与组件"
                )
            ]
        )

        skipped = await skip_redundant_works(root=root, project_id="project-1", ledger=ledger)

        assert skipped == 0
        assert ledger.items[0].status == "pending"
    finally:
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_skip_requires_changed_files(tmp_path, monkeypatch) -> None:
    """没有登记产物的纯验证/审计类 Work 不参与跳过。"""

    _isolate_db(tmp_path, monkeypatch)
    await initialize_database()
    try:
        root = tmp_path / "project"
        root.mkdir()
        await record_completed_works(
            "project-1",
            [_completed_item(changed_files=[])],
        )
        ledger = WorkLedger([_pending_work()])

        skipped = await skip_redundant_works(root=root, project_id="project-1", ledger=ledger)

        assert skipped == 0
        assert ledger.items[0].status == "pending"
    finally:
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_record_filters_non_succeeded(tmp_path, monkeypatch) -> None:
    """只有 succeeded 的 Work 才登记，失败/跳过的不登记。"""

    _isolate_db(tmp_path, monkeypatch)
    await initialize_database()
    try:
        root = tmp_path / "project"
        root.mkdir()
        recorded = await record_completed_works(
            "project-1",
            [
                _completed_item(),
                _completed_item(title="失败的 Work", status="failed"),
                _completed_item(title="跳过的 Work", status="skipped"),
            ],
        )

        assert recorded == 1
        ledger = WorkLedger([_pending_work(title="失败的 Work")])
        assert await skip_redundant_works(root=root, project_id="project-1", ledger=ledger) == 0
    finally:
        get_settings.cache_clear()


def test_title_key_normalizes_punctuation() -> None:
    """标题键应忽略空白和标点，保证跨会话标题一致。"""

    assert title_key("Apple 风格设计基座与共享 UI 组件") == title_key(
        "Apple 风格设计基座与共享UI组件"
    )
