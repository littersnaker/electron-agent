"""Amazon 评论数据源（公开评论页爬虫 + 解析）测试。"""

from __future__ import annotations

import pytest

import backend.services.commerce.sources.amazon_reviews as reviews
from backend.services.commerce.marketplaces import get_marketplace


class _FakeResponse:
    """模拟 httpx.Response。"""

    def __init__(self, payload, status_code: int = 200) -> None:
        self._payload = payload
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

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

    async def get(self, url, **kwargs):
        return self._handler("get", url, kwargs)


def _patch_client(monkeypatch, handler) -> None:
    monkeypatch.setattr(
        reviews.httpx,
        "AsyncClient",
        lambda **_kwargs: _FakeClient(handler),
    )


_REVIEW_HTML = """
<div data-hook="review">
  <a data-hook="review-title">Nice quality</a>
  <i class="a-icon a-icon-star a-star-5">5.0 out of 5 stars</i>
  <span data-hook="review-body"><span>Really solid build, works as expected.</span></span>
  <a data-hook="review-author">John D.</a>
  <span data-hook="review-date">January 1, 2026</span>
  <span>Verified Purchase</span>
</div>
<div data-hook="review">
  <a data-hook="review-title">Not great</a>
  <i class="a-icon a-icon-star a-star-3">3.0 out of 5 stars</i>
  <span data-hook="review-body"><span>Packaging was torn, but product itself is okay.</span></span>
  <span class="a-profile-name">Alice</span>
  <span data-hook="review-date">December 20, 2025</span>
</div>
"""


@pytest.mark.asyncio
async def test_parse_review_page_extracts_fields(monkeypatch) -> None:
    """评论页应解析出评分/标题/正文/作者/日期/验证购买。"""

    def handler(_method, _url, _kwargs):
        return _FakeResponse(_REVIEW_HTML)

    _patch_client(monkeypatch, handler)

    rows, diagnostic = await reviews.fetch_amazon_reviews(
        "B0REVIEWX1",
        get_marketplace("US"),
        {},
        limit=10,
    )

    assert diagnostic["mode"] == "crawler"
    assert len(rows) == 2
    assert rows[0]["asin"] == "B0REVIEWX1"
    assert rows[0]["rating"] == 5.0
    assert rows[0]["title"] == "Nice quality"
    assert "Really solid build" in rows[0]["text"]
    assert rows[0]["author"] == "John D."
    assert rows[0]["verifiedPurchase"] is True
    assert rows[1]["rating"] == 3.0
    assert rows[1]["verifiedPurchase"] is False


@pytest.mark.asyncio
async def test_fetch_stops_at_last_page(monkeypatch) -> None:
    """当某页解析结果明显不足一页（<5 条）时应提前停止翻页。"""

    calls: list[str] = []

    def handler(_method, url, _kwargs):
        calls.append(url)
        return _FakeResponse(_REVIEW_HTML)

    _patch_client(monkeypatch, handler)

    await reviews.fetch_amazon_reviews("B0REVIEWX1", get_marketplace("US"), {})

    # 第一页 2 条 < 5，不应继续翻第 2 页。
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_fetch_raises_when_no_reviews(monkeypatch) -> None:
    """评论页没有可解析评论（如反爬页）时应抛明确错误，由上层降级。"""

    def handler(_method, _url, _kwargs):
        return _FakeResponse("<html><body>captcha</body></html>")

    _patch_client(monkeypatch, handler)

    with pytest.raises(RuntimeError, match="未解析到评论"):
        await reviews.fetch_amazon_reviews("B0REVIEWX1", get_marketplace("US"), {})


@pytest.mark.asyncio
async def test_crawler_can_be_disabled_by_environment(monkeypatch) -> None:
    """COMMERCE_AMAZON_CRAWLER=0 时评论爬虫应直接报错，不发起请求。"""

    monkeypatch.setenv("COMMERCE_AMAZON_CRAWLER", "0")

    with pytest.raises(RuntimeError, match="关闭"):
        await reviews.fetch_amazon_reviews("B0REVIEWX1", get_marketplace("US"), {})
