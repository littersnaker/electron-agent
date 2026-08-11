"""Listing 草稿状态机与内容更新测试。"""

from __future__ import annotations

import asyncio

import pytest

from backend.core.config import get_settings
from backend.services.commerce.drafts import (
    CONFIRMED,
    DraftNotEditableError,
    list_listing_drafts,
    save_listing_draft,
    update_listing_draft_content,
    update_listing_draft_status,
)
from backend.services.workspace.database import initialize_database


@pytest.fixture()
def db(monkeypatch, tmp_path) -> object:
    """隔离的 SQLite 数据库（listing_drafts 表 + 迁移）。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    asyncio.run(initialize_database())
    yield tmp_path
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_pending_draft_can_be_edited(db) -> None:
    draft_id = await save_listing_draft(
        session_id="s1",
        query="yoga mat",
        marketplace="US",
        draft={"title": "Yoga Mat"},
        source="llm",
    )
    updated = await update_listing_draft_content(
        draft_id,
        draft={"title": "Yoga Mat 5mm"},
        notes="按运营反馈调整标题",
    )
    assert updated is True
    items = await list_listing_drafts(status="pending")
    item = next(item for item in items if item["id"] == draft_id)
    assert item["draft"]["title"] == "Yoga Mat 5mm"
    assert item["notes"] == "按运营反馈调整标题"
    assert item["updatedAt"] is not None


@pytest.mark.asyncio
async def test_confirmed_draft_rejects_edit(db) -> None:
    draft_id = await save_listing_draft(
        session_id="s1",
        query="yoga mat",
        marketplace="US",
        draft={"title": "Yoga Mat"},
        source="llm",
    )
    assert await update_listing_draft_status(draft_id, CONFIRMED) is True
    with pytest.raises(DraftNotEditableError) as exc:
        await update_listing_draft_content(
            draft_id,
            draft={"title": "已确认后不可编辑"},
        )
    assert "已确认" in str(exc.value)


@pytest.mark.asyncio
async def test_terminal_status_cannot_change_again(db) -> None:
    draft_id = await save_listing_draft(
        session_id="s1",
        query="yoga mat",
        marketplace="US",
        draft={"title": "Yoga Mat"},
        source="template",
    )
    assert await update_listing_draft_status(draft_id, "rejected") is True
    with pytest.raises(DraftNotEditableError):
        await update_listing_draft_status(draft_id, "confirmed")
    # 草稿仍保持已驳回状态。
    items = await list_listing_drafts(status="rejected")
    assert any(item["id"] == draft_id for item in items)


@pytest.mark.asyncio
async def test_update_missing_draft_returns_false(db) -> None:
    assert (
        await update_listing_draft_content(
            "draft_missing",
            draft={"title": "Nope"},
        )
        is False
    )
    assert (
        await update_listing_draft_status("draft_missing", "confirmed") is False
    )


@pytest.mark.asyncio
async def test_unsupported_status_raises_value_error(db) -> None:
    draft_id = await save_listing_draft(
        session_id="s1",
        query="yoga mat",
        marketplace="US",
        draft={},
        source="template",
    )
    with pytest.raises(ValueError):
        await update_listing_draft_status(draft_id, "archived")
