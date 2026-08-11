"""Amazon 数据源（SP-API + 公开页爬虫 + 降级链）测试。"""

from __future__ import annotations

import pytest

import backend.services.commerce.sources.amazon as amazon
from backend.services.commerce.marketplaces import get_marketplace


class _FakeResponse:
    """模拟 httpx.Response。"""

    def __init__(self, payload, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        return self._payload

    @property
    def text(self) -> str:
        return str(self._payload)


class _FakeClient:
    """模拟 httpx.AsyncClient 的异步上下文。"""

    def __init__(self, handler) -> None:
        self._handler = handler

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args) -> bool:
        return False

    async def post(self, url, **kwargs):
        return self._handler("post", url, kwargs)

    async def get(self, url, **kwargs):
        return self._handler("get", url, kwargs)


def _patch_client(monkeypatch, handler) -> None:
    monkeypatch.setattr(
        amazon.httpx,
        "AsyncClient",
        lambda **_kwargs: _FakeClient(handler),
    )


@pytest.mark.asyncio
async def test_exchange_access_token_parses_token(monkeypatch) -> None:
    """LWA 换取的 access_token 应被正确解析。"""

    def handler(_method, _url, _kwargs):
        return _FakeResponse({"access_token": "tok123", "expires_in": 3600})

    _patch_client(monkeypatch, handler)

    token = await amazon.exchange_access_token("cid", "csec", "rtok")

    assert token == "tok123"


@pytest.mark.asyncio
async def test_sp_api_search_normalizes_catalog(monkeypatch) -> None:
    """配置 SP-API 凭据时应走官方 Catalog Search 并标准化为 observation。"""

    captured: dict = {}

    def handler(method, url, kwargs):
        if "auth/o2/token" in url:
            return _FakeResponse({"access_token": "tok123"})
        captured["url"] = url
        captured["headers"] = kwargs.get("headers", {})
        return _FakeResponse(
            {
                "items": [
                    {
                        "asin": "B0TEST0001",
                        "summaries": [{"itemName": "Wireless Earbuds Pro"}],
                    }
                ]
            }
        )

    _patch_client(monkeypatch, handler)
    creds = {
        "amazon_client_id": "cid",
        "amazon_client_secret": "csec",
        "amazon_refresh_token": "rtok",
    }

    rows, diagnostic = await amazon.search_amazon(
        "earbuds",
        get_marketplace("US"),
        creds,
        limit=4,
    )

    assert diagnostic["mode"] == "sp-api"
    assert rows
    assert rows[0]["id"] == "amazon-B0TEST0001"
    assert rows[0]["title"] == "Wireless Earbuds Pro"
    assert "catalog/2022-04-01/items" in captured["url"]
    assert captured["headers"].get("x-amz-access-token") == "tok123"


_SEARCH_HTML = """
<div data-asin="B0CRAWL0X1" data-component-type="s-search-result">
  <h2><span>Yoga Mat Extra Thick</span></h2>
  <span class="a-price"><span><span class="a-offscreen">$19.99</span></span></span>
  <span class="a-icon-alt">4.6 out of 5 stars</span>
  <span class="a-size-base s-underline-text">1,234</span>
</div>
"""


@pytest.mark.asyncio
async def test_crawler_parses_search_html(monkeypatch) -> None:
    """未配置凭据时应回退公开页爬虫并解析出标题/价格/评分/评论数。"""

    def handler(_method, _url, _kwargs):
        return _FakeResponse(_SEARCH_HTML)

    _patch_client(monkeypatch, handler)

    rows, diagnostic = await amazon.search_amazon(
        "yoga mat",
        get_marketplace("US"),
        {},
        limit=4,
    )

    assert diagnostic["mode"] == "crawler"
    assert rows
    assert rows[0]["id"] == "amazon-B0CRAWL0X1"
    assert rows[0]["title"] == "Yoga Mat Extra Thick"
    assert rows[0]["price"] == 19.99
    assert rows[0]["rating"] == 4.6
    assert rows[0]["reviewCount"] == 1234
    assert rows[0]["provider"] == "amazon-public-page"


@pytest.mark.asyncio
async def test_crawler_raises_when_no_results(monkeypatch) -> None:
    """搜索页没有可解析商品（如反爬页）时应抛明确错误，由上层降级。"""

    def handler(_method, _url, _kwargs):
        return _FakeResponse("<html><body>captcha</body></html>")

    _patch_client(monkeypatch, handler)

    with pytest.raises(RuntimeError, match="未解析到商品"):
        await amazon.search_amazon("yoga mat", get_marketplace("US"), {})


@pytest.mark.asyncio
async def test_crawler_can_be_disabled_by_environment(monkeypatch) -> None:
    """COMMERCE_AMAZON_CRAWLER=0 时爬虫路径应直接报错，不发起请求。"""

    monkeypatch.setenv("COMMERCE_AMAZON_CRAWLER", "0")

    with pytest.raises(RuntimeError, match="关闭"):
        await amazon.search_amazon("yoga mat", get_marketplace("US"), {})
