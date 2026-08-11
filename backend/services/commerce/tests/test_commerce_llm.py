"""电商 LLM 参与层测试：结构化输出、静默回退、人工确认草稿。"""

from __future__ import annotations

import asyncio
import json

import pytest

from backend.core.config import get_settings
from backend.schemas.commerce import CommerceRequest
from backend.services.commerce import langgraph as langgraph_module
from backend.services.commerce.drafts import (
    list_listing_drafts,
    save_listing_draft,
    update_listing_draft_status,
)
from backend.services.commerce.llm import (
    CommerceCategoryAnalysis,
    LlmConfig,
    try_complete_json,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.workspace.database import initialize_database


@pytest.fixture()
def db(monkeypatch, tmp_path) -> object:
    """隔离的 SQLite 数据库（listing_drafts 表）。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    asyncio.run(initialize_database())
    yield tmp_path
    get_settings.cache_clear()


def _request(query: str = "yoga mat") -> CommerceRequest:
    return CommerceRequest(query=query)


def _llm() -> LlmConfig:
    return LlmConfig(
        credentials=LlmCredentials({"qwen": "sk-test"}),
        model_id="auto",
    )


# ---------------------------------------------------------------------------
# LLM 辅助层：结构化输出 + 静默回退
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_try_complete_json_skips_without_key() -> None:
    result = await try_complete_json(
        None,
        system_prompt="s",
        user_prompt="u",
        schema_cls=CommerceCategoryAnalysis,
    )
    assert result is None


@pytest.mark.asyncio
async def test_try_complete_json_parses_valid_output(monkeypatch) -> None:
    class FakeGateway:
        async def complete(self, **_: object) -> tuple[str, object, object]:
            payload = {
                "categoryName": "瑜伽垫",
                "categoryNameEn": "Yoga Mat",
                "keywords": ["yoga mat", "non slip"],
            }
            return json.dumps(payload, ensure_ascii=False), object(), object()

    from backend.services.commerce import llm as llm_module

    monkeypatch.setattr(llm_module, "GATEWAY", FakeGateway())
    result = await try_complete_json(
        _llm(),
        system_prompt="s",
        user_prompt="u",
        schema_cls=CommerceCategoryAnalysis,
    )
    assert result is not None
    assert result.categoryName == "瑜伽垫"
    assert result.keywords == ["yoga mat", "non slip"]


@pytest.mark.asyncio
async def test_try_complete_json_discards_invalid_output(monkeypatch) -> None:
    class FakeGateway:
        async def complete(self, **_: object) -> tuple[str, object, object]:
            return "不是 JSON", object(), object()

    from backend.services.commerce import llm as llm_module

    monkeypatch.setattr(llm_module, "GATEWAY", FakeGateway())
    result = await try_complete_json(
        _llm(),
        system_prompt="s",
        user_prompt="u",
        schema_cls=CommerceCategoryAnalysis,
    )
    assert result is None


# ---------------------------------------------------------------------------
# 研究图：LLM 参与品类与洞察（monkeypatch 注入）
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_research_uses_llm_category_and_insights(monkeypatch) -> None:
    async def fake_amazon(_query, _marketplace, _creds, _limit):
        return [], {"mode": "crawler"}

    monkeypatch.setattr(langgraph_module, "search_amazon", fake_amazon)

    class FakeInsights:
        def __init__(self) -> None:
            self.source = {"summary": "市场信号总结", "opportunities": [], "risks": [], "actions": []}

        def model_dump(self) -> dict[str, object]:
            return self.source

    graph = langgraph_module.build_research_graph(_request(), {}, llm=_llm())
    # insights 也走 try_complete_json：改为按 schema 参数区分
    async def fake_any(*_args, schema_cls=None, **_kwargs):
        if schema_cls is CommerceCategoryAnalysis:
            return CommerceCategoryAnalysis(
                categoryName="瑜伽垫",
                categoryNameEn="Yoga Mat",
                keywords=["yoga mat"],
            )
        return FakeInsights()

    monkeypatch.setattr(langgraph_module, "try_complete_json", fake_any)
    state = await graph.ainvoke(
        {
            "query": "yoga mat",
            "marketplace": {},
            "sample_size": 24,
            "credentials": {},
            "category": {},
            "observations": [],
            "warnings": [],
            "diagnostic": {},
            "products": [],
            "metrics": {},
            "insights": {},
            "insights_source": "template",
            "report": {},
            "is_demo": False,
            "platform_status": [],
        }
    )
    assert state["category"]["categoryName"] == "瑜伽垫"
    assert state["category"].get("llmEnhanced") is True
    assert state["insights_source"] == "llm"
    assert state["report"]["llmEnhanced"] is True


# ---------------------------------------------------------------------------
# Listing：草稿持久化 + 人工确认
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_listing_report_persists_draft_and_confirmation(db) -> None:
    graph = langgraph_module.build_listing_graph(_request("yoga mat"))
    state = await graph.ainvoke(
        {
            "query": "yoga mat",
            "marketplace": {},
            "category": {},
            "mock_erp": {},
            "keywords": [],
            "draft": {},
            "draft_source": "template",
            "draft_feedback": "",
            "draft_id": "",
            "validation": {},
            "report": {},
            "retries": 0,
        }
    )
    report = state["report"]
    assert report["requiresHumanConfirmation"] is True
    assert report["humanConfirmation"]["status"] == "pending"
    assert report["draftId"]
    pending = await list_listing_drafts(status="pending")
    assert any(item["id"] == report["draftId"] for item in pending)
    assert await update_listing_draft_status(report["draftId"], "confirmed") is True
    confirmed = await list_listing_drafts(status="confirmed")
    assert any(item["id"] == report["draftId"] for item in confirmed)


@pytest.mark.asyncio
async def test_draft_store_roundtrip(db) -> None:
    draft_id = await save_listing_draft(
        session_id="s1",
        query="yoga mat",
        marketplace="US",
        draft={"title": "Yoga Mat"},
        source="template",
    )
    assert draft_id.startswith("draft_")
    items = await list_listing_drafts(status="pending")
    assert any(item["id"] == draft_id and item["draft"]["title"] == "Yoga Mat" for item in items)
    assert await update_listing_draft_status(draft_id, "rejected", notes="描述需补充") is True
    rejected = await list_listing_drafts(status="rejected")
    item = next(item for item in rejected if item["id"] == draft_id)
    assert item["notes"] == "描述需补充"
