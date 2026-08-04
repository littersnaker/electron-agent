"""SQLite Memory Router 测试。"""

from __future__ import annotations

import pytest

from backend.core.config import get_settings
from backend.memory.memory_router import MemoryRouter
from backend.services.workspace.database import initialize_database


@pytest.mark.asyncio
async def test_memory_router_persists_and_searches(monkeypatch, tmp_path) -> None:
    """Memory 应写入项目数据库，并能按项目作用域检索。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    try:
        await initialize_database()
        router = MemoryRouter()
        store = router.get_store("semantic")
        created = await store.save(
            scope_id="project-1",
            content="统一 Agent Runtime 使用 Tool Gateway。",
            metadata={"source": "test"},
        )

        records = await router.search(
            memory_types=("semantic",),
            query="Tool Gateway",
            scope_ids=("project-1",),
            top_k=5,
        )

        assert records
        assert records[0].id == created.id
        assert records[0].metadata["source"] == "test"
    finally:
        get_settings.cache_clear()
