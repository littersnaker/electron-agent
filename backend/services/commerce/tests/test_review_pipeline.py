"""评论分析管线测试：采集 → 统计 → 报告集成与降级兜底。"""

from __future__ import annotations

import pytest

from backend.schemas.commerce import CommerceRequest
from backend.services.commerce import langgraph as module
from backend.services.commerce.langgraph import build_research_graph

_AMAZON_OBSERVATION = {
    "id": "amazon-B0TEST0001",
    "title": "Wireless Earbuds Pro",
    "url": "https://www.amazon.com/dp/B0TEST0001",
    "domain": "www.amazon.com",
    "snippet": "",
    "resultType": "shopping",
    "position": 1,
    "price": 29.9,
    "currency": "USD",
    "rating": 4.5,
    "reviewCount": 120,
    "merchant": "Amazon",
    "provider": "amazon-public-page",
}

_DEMO_OBSERVATION = {
    "id": "DEMO-abc-1",
    "title": "演示商品",
    "url": None,
    "domain": "demo1.example",
    "snippet": "",
    "resultType": "shopping",
    "position": 1,
    "price": 19.9,
    "currency": "USD",
    "rating": 4.2,
    "reviewCount": 80,
    "merchant": "Demo Seller 1",
    "provider": "demo-market",
    "isDemo": True,
}


def _initial_state(observations: list[dict]) -> dict:
    return {
        "query": "earbuds",
        "marketplace": {},
        "sample_size": 24,
        "credentials": {},
        "category": {},
        "observations": observations,
        "warnings": [],
        "diagnostic": {},
        "products": [],
        "metrics": {},
        "insights": {},
        "report": {},
        "is_demo": False,
        "platform_status": [],
    }


async def _no_amazon_results(_query, _marketplace, _creds, _limit=None, **_kwargs):
    """让平台采集分支确定性返回空，避免测试依赖真实网络。"""

    return [], {"mode": "crawler", "parsedResultCount": 0}


def _fake_reviews(limit: int = 30):
    """构造 2 条带情感倾向的评论。"""

    async def _call(_asin, _marketplace, _creds, limit: int = 30, **_kwargs):
        return [
            {
                "id": f"amazon-review-{_asin}-1",
                "asin": _asin,
                "rating": 5.0,
                "title": "Nice quality",
                "text": "Really solid build, 性价比高, 耐用, 推荐",
                "author": "John",
                "date": "2026-01-01",
                "verifiedPurchase": True,
                "isDemo": False,
            },
            {
                "id": f"amazon-review-{_asin}-2",
                "asin": _asin,
                "rating": 2.0,
                "title": "Bad",
                "text": "质量差, 失望, 问题多, 客服慢",
                "author": "Alice",
                "date": "2025-12-01",
                "verifiedPurchase": False,
                "isDemo": False,
            },
        ][: max(limit, 2)], {}

    return _call


def _patch_sources(monkeypatch) -> None:
    """拦截所有外部采集源，保证图执行不触网、结果可预期。"""

    monkeypatch.setattr(module, "search_amazon", _no_amazon_results)
    monkeypatch.setattr(module, "fetch_amazon_reviews", _fake_reviews())


@pytest.mark.asyncio
async def test_review_pipeline_injects_analyses_into_report(monkeypatch) -> None:
    """Amazon 商品存在时，报告应包含 reviewAnalyses 区块与评论数据源。"""

    _patch_sources(monkeypatch)

    body = CommerceRequest(query="earbuds")
    graph = build_research_graph(body, {})
    state = await graph.ainvoke(_initial_state([_AMAZON_OBSERVATION]))

    analyses = state["report"]["reviewAnalyses"]
    assert analyses
    analysis = analyses[0]
    assert analysis["asin"] == "B0TEST0001"
    assert analysis["stats"]["sampleSize"] == 2
    assert analysis["stats"]["averageRating"] == 3.5
    assert analysis["stats"]["ratingDistribution"]["5"] == 1
    assert analysis["stats"]["ratingDistribution"]["2"] == 1
    assert analysis["positiveTopics"]
    assert analysis["negativeTopics"]
    assert analysis["dataSource"]["isDemo"] is False
    assert analysis["samples"][0]["rating"] == 5.0
    # 数据源列表包含 amazon-reviews 且为 collected。
    by_id = {item["id"]: item for item in state["report"]["sources"]}
    assert by_id["amazon-reviews"]["status"] == "collected"
    assert by_id["amazon-reviews"]["sampleSize"] == 2


@pytest.mark.asyncio
async def test_review_pipeline_skips_when_no_amazon_products(monkeypatch) -> None:
    """没有 Amazon 商品时，评论分析应跳过并给出 unconfigured 数据源。"""

    _patch_sources(monkeypatch)

    body = CommerceRequest(query="earbuds")
    graph = build_research_graph(body, {})
    state = await graph.ainvoke(_initial_state([_DEMO_OBSERVATION]))

    assert state["report"]["reviewAnalyses"] == []
    by_id = {item["id"]: item for item in state["report"]["sources"]}
    assert by_id["amazon-reviews"]["status"] == "unconfigured"


@pytest.mark.asyncio
async def test_review_pipeline_falls_back_to_demo_on_failure(monkeypatch) -> None:
    """评论采集失败时，该商品降级为演示样本，报告仍能生成。"""

    async def fake_fail(_asin, _marketplace, _creds, _limit=None, **_kwargs):
        raise RuntimeError("反爬拦截")

    monkeypatch.setattr(module, "search_amazon", _no_amazon_results)
    monkeypatch.setattr(module, "fetch_amazon_reviews", fake_fail)

    body = CommerceRequest(query="earbuds")
    graph = build_research_graph(body, {})
    state = await graph.ainvoke(_initial_state([_AMAZON_OBSERVATION]))

    analyses = state["report"]["reviewAnalyses"]
    assert analyses
    assert analyses[0]["dataSource"]["isDemo"] is True
    assert analyses[0]["warnings"]
    by_id = {item["id"]: item for item in state["report"]["sources"]}
    assert by_id["amazon-reviews"]["status"] == "demo"


@pytest.mark.asyncio
async def test_review_stats_and_sentiment_functions() -> None:
    """纯函数：统计与确定性情感应稳定输出。"""

    from backend.services.commerce.analytics import (
        calculate_review_stats,
        deterministic_review_sentiment,
    )

    reviews = [
        {"rating": 5, "title": "Nice", "text": "质量好 耐用 推荐", "verifiedPurchase": True},
        {"rating": 2, "title": "Bad", "text": "质量差 失望", "verifiedPurchase": False},
    ]
    stats = calculate_review_stats(reviews)
    assert stats["sampleSize"] == 2
    assert stats["averageRating"] == 3.5
    assert stats["ratingDistribution"]["5"] == 1
    assert stats["ratingDistribution"]["1"] == 0
    assert stats["positiveRatio"] == 0.5
    assert stats["verifiedPurchaseRatio"] == 0.5

    sentiment = deterministic_review_sentiment(reviews)
    assert "质量" in sentiment["positiveTopics"] or "耐用" in sentiment["positiveTopics"]
    assert "失望" in sentiment["negativeTopics"] or "质量" in sentiment["negativeTopics"]
    assert "2 条评论" in sentiment["summary"]
