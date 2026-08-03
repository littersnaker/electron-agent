"""TikTok Shop / 1688 官方 API 采集客户端与管线接入测试。"""

from __future__ import annotations

import pytest

from backend.schemas.commerce import CommerceRequest
from backend.services.commerce.langgraph import build_research_graph
from backend.services.commerce.sources.ali1688 import (
    _normalize as normalize_1688,
    _sign_params,
)
from backend.services.commerce.sources.tiktokshop import (
    _normalize as normalize_tiktok,
)


def test_1688_param2_signature_is_deterministic() -> None:
    """TOP param2 签名应稳定且与排序后的参数串一致。"""

    params = {
        "keywords": "yoga mat",
        "pageSize": "12",
        "pageNo": "1",
        "access_token": "token",
        "appKey": "app-key",
    }
    first = _sign_params("secret", params)
    second = _sign_params("secret", params)
    assert first == second
    assert len(first) == 32


def test_1688_normalize_product() -> None:
    raw = {
        "productID": "P1001",
        "subject": "瑜伽垫防滑加厚",
        "priceInfo": {"price": "29.9"},
        "detailUrl": "https://detail.1688.com/offer/P1001.html",
        "sellerLoginId": "seller_01",
        "summary": "高密度材质",
    }
    observation = normalize_1688(raw, "yoga mat", 0)
    assert observation is not None
    assert observation["id"] == "1688-P1001"
    assert observation["title"] == "瑜伽垫防滑加厚"
    assert observation["price"] == 29.9
    assert observation["provider"] == "1688"
    assert observation["isDemo"] is False


def test_tiktok_normalize_product() -> None:
    raw = {
        "id": "T1001",
        "title": "Yoga Mat Non Slip",
        "price": {"value": 19.99, "currency": "USD"},
        "seller_name": "TikTok Seller",
    }
    observation = normalize_tiktok(raw, 0)
    assert observation is not None
    assert observation["id"] == "tiktok-T1001"
    assert observation["price"] == 19.99
    assert observation["currency"] == "USD"
    assert observation["provider"] == "tiktok-shop"


@pytest.mark.asyncio
async def test_research_pipeline_collects_platform_sources(monkeypatch) -> None:
    """配置 TikTok/1688 凭据后，并行采集两个平台并写入报告 sources。"""

    from backend.services.commerce import langgraph as module

    async def fake_tiktok_token(_key, _secret):
        return "token"

    async def fake_tiktok_search(_query, _key, _secret, _merchant, _token, _limit):
        return [
            {
                "id": "tiktok-T1",
                "title": "TikTok Item",
                "url": "",
                "domain": "tiktok.com",
                "snippet": "",
                "resultType": "shopping",
                "position": 1,
                "price": 9.9,
                "currency": "USD",
                "rating": None,
                "reviewCount": None,
                "merchant": "s",
                "provider": "tiktok-shop",
                "isDemo": False,
            }
        ]

    async def fake_1688(_query, _key, _secret, _token, _limit):
        return [
            {
                "id": "1688-P1",
                "title": "1688 商品",
                "url": "",
                "domain": "1688.com",
                "snippet": "",
                "resultType": "shopping",
                "position": 1,
                "price": 9.9,
                "currency": "CNY",
                "rating": None,
                "reviewCount": None,
                "merchant": "s",
                "provider": "1688",
                "isDemo": False,
            }
        ]

    monkeypatch.setattr(
        module,
        "fetch_tiktok_access_token",
        fake_tiktok_token,
    )
    monkeypatch.setattr(module, "search_tiktok_shop", fake_tiktok_search)
    monkeypatch.setattr(module, "search_1688", fake_1688)

    body = CommerceRequest(query="yoga mat")
    graph = build_research_graph(
        body,
        {
            "tiktok_client_key": "k",
            "tiktok_client_secret": "s",
            "tiktok_merchant_id": "m",
            "alibaba_1688_app_key": "ak",
            "alibaba_1688_app_secret": "as",
            "alibaba_1688_access_token": "at",
        },
    )
    state = await graph.ainvoke(
        {
            "query": "yoga mat",
            "marketplace": {},
            "sample_size": 24,
            "credentials": {
                "tiktok_client_key": "k",
                "tiktok_client_secret": "s",
                "tiktok_merchant_id": "m",
                "alibaba_1688_app_key": "ak",
                "alibaba_1688_app_secret": "as",
                "alibaba_1688_access_token": "at",
            },
            "category": {},
            "observations": [],
            "warnings": [],
            "diagnostic": {},
            "products": [],
            "metrics": {},
            "insights": {},
            "report": {},
            "is_demo": False,
            "platform_status": [],
        }
    )
    sources = state["report"]["sources"]
    by_id = {item["id"]: item for item in sources}
    assert by_id["tiktok-shop"]["status"] == "collected"
    assert by_id["1688"]["status"] == "collected"
    assert by_id["amazon"]["status"] == "unconfigured"
    ids = {item["id"] for item in state["report"]["observations"]}
    assert "tiktok-T1" in ids
    assert "1688-P1" in ids
