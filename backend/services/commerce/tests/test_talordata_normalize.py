"""TalorData 结果标准化测试。"""

from __future__ import annotations

from backend.services.commerce.marketplaces import get_marketplace
from backend.services.commerce.talordata import normalize_observation


def test_google_shopping_echo_link_is_dropped() -> None:
    """Google 购物 SERP 回链应被清空，避免前端渲染出无效跳转。"""

    item = {
        "title": "Wireless Earbuds Pro",
        "link": (
            "https://www.google.com/webhp?ibp=oshop&prds=catalogid:,headlineOfferDocid:,"
            "imageDocid:,rds:,gpcid:,mid:,pvt:&hl=en&gl=us&udm=28"
        ),
        "price": 29.9,
    }
    result = normalize_observation("shopping_results", item, get_marketplace("US"))

    assert result is not None
    assert result["url"] is None
    assert result["domain"] is None
    assert result["title"] == "Wireless Earbuds Pro"
    assert result["price"] == 29.9


def test_google_webhp_without_shopping_echo_is_preserved() -> None:
    """非 ibp=oshop 的 Google 链接不应被误伤。"""

    item = {
        "title": "Some Page",
        "link": "https://www.google.com/search?q=yoga+mat",
    }
    result = normalize_observation("organic", item, get_marketplace("US"))

    assert result is not None
    assert result["url"] == "https://www.google.com/search?q=yoga+mat"
    assert result["domain"] == "google.com"


def test_regular_product_link_is_preserved() -> None:
    """真实商品详情页链接应原样保留。"""

    item = {
        "title": "Yoga Mat Extra Thick",
        "link": "https://www.amazon.com/dp/B0TEST0001",
        "price": 19.99,
    }
    result = normalize_observation("shopping_results", item, get_marketplace("US"))

    assert result is not None
    assert result["url"] == "https://www.amazon.com/dp/B0TEST0001"
    assert result["domain"] == "amazon.com"
    assert result["price"] == 19.99
