"""Commerce 市场研究与 Listing 的 LangGraph 管线测试。"""

from __future__ import annotations

import pytest

from backend.schemas.commerce import CommerceRequest
from backend.services.commerce.langgraph import (
    build_listing_graph,
    build_research_graph,
)


def _request(query: str = "yoga mat") -> CommerceRequest:
    return CommerceRequest(query=query)


@pytest.mark.asyncio
async def test_research_demo_fallback_builds_full_report(monkeypatch) -> None:
    """无数据源 token 时走 Demo 兜底，报告结构完整且标记 isDemo。"""

    from backend.services.commerce import langgraph as module

    async def fake_amazon(_query, _marketplace, _creds, _limit):
        return [], {"mode": "crawler"}

    monkeypatch.setattr(module, "search_amazon", fake_amazon)
    graph = build_research_graph(_request(), {})
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
    report = state["report"]
    assert report["runMode"] == "demo"
    assert report["observations"]
    assert report["metrics"]["observationCount"] > 0
    assert report["sources"][0]["status"] == "demo"


@pytest.mark.asyncio
async def test_research_parallel_collection_with_token(monkeypatch) -> None:
    """有 token 时按关键词×引擎并行采集并去重。"""

    from backend.services.commerce import langgraph as module

    calls: list[tuple[str, str]] = []

    async def fake_search(_token, keyword, _marketplace, engine, _sample):
        calls.append((keyword, engine))
        return (
            [
                {
                    "id": f"{keyword}-{engine}-1",
                    "title": "item",
                    "url": None,
                    "domain": "shop.example",
                    "snippet": "",
                    "resultType": "shopping",
                    "position": 1,
                    "price": 19.9,
                    "currency": "USD",
                    "rating": 4.2,
                    "reviewCount": 100,
                    "merchant": "seller",
                    "provider": "talordata-market",
                    "isDemo": False,
                }
            ],
            {"ok": True},
        )

    async def fake_amazon(_query, _marketplace, _creds, _limit):
        return [], {"mode": "crawler"}

    monkeypatch.setattr(module, "request_search", fake_search)
    monkeypatch.setattr(
        module,
        "search_amazon",
        fake_amazon,
    )
    graph = build_research_graph(_request("wireless earbuds"), {"talordata": "token"})
    state = await graph.ainvoke(
        {
            "query": "wireless earbuds",
            "marketplace": {},
            "sample_size": 24,
            "credentials": {"talordata": "token"},
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
    assert calls, "应并行发起多源搜索"
    assert len({(k, e) for k, e in calls}) == len(calls)
    assert state["report"]["runMode"] == "market-intelligence"
    assert state["report"]["observations"]


@pytest.mark.asyncio
async def test_listing_pipeline_builds_report() -> None:
    """Listing 管线产出完整 demo 报告。"""

    graph = build_listing_graph(_request("yoga mat"))
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
    assert report["mode"] == "listing-demo"
    assert report["draft"]["title"]
    assert report["validation"]["score"]["overall"] > 0
    assert report["mockErp"]["sku"] == "DEMO-SKU-PENDING"
