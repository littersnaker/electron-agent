"""Amazon 商品评论采集数据源：公开评论页爬虫。

评论页没有官方公开 API，直接抓取 ``https://{domain}/product-reviews/{asin}``
并按页翻页（每页约 10 条）。解析失败/被反爬拦截时以异常上抛，由上层
降级到演示数据，不中断研究报告流水线。
"""

from __future__ import annotations

import html
import os
import re
import time
from typing import Any
from urllib.parse import quote

import httpx

from backend.services.commerce.marketplaces import Marketplace

_CRAWLER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml",
}
DEFAULT_TIMEOUT = httpx.Timeout(20.0, connect=10.0)
# 默认翻 3 页（约 30 条）；2-3 页在耗时与统计稳定性之间折中。
REVIEW_PAGES = 3


def _first(pattern: str, text: str) -> str:
    """返回第一个正则命中的 HTML 文本（去实体、去标签）。"""

    match = re.search(pattern, text, re.DOTALL | re.IGNORECASE)
    if not match:
        return ""
    value = html.unescape(match.group(1)).strip()
    return re.sub(r"<[^>]+>", "", value).strip()


def _number(value: str) -> float | None:
    """把 "5.0 out of 5 stars" 转成数字。"""

    match = re.search(r"([0-9]+(?:\.[0-9]+)?)", value.replace(",", ""))
    if not match:
        return None
    try:
        number = float(match.group(1))
    except ValueError:
        return None
    return number if number > 0 else None


def _rating_from_class(text: str) -> float | None:
    """从 ``a-star-5`` 这类 class 提取星级（评论页评分在 class 里）。"""

    match = re.search(r"a-star-([0-9]+)(?:-[0-9]+)?", text)
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def _verified(text: str) -> bool:
    """判断评论是否标记为 Verified Purchase。"""

    return bool(re.search(r"verified\s*purchase", text, re.IGNORECASE))


def _parse_reviews_html(page: str, asin: str, limit: int) -> list[dict[str, Any]]:
    """从 Amazon 评论页 HTML 解析评论条目（无第三方解析库，正则兜底）。"""

    rows: list[dict[str, Any]] = []
    markers = list(re.finditer(r'<div[^>]*data-hook="review"[^>]*>', page))
    for index, marker in enumerate(markers):
        start = marker.start()
        # 下一个 review 区块之前即本条评论范围；兜底截断避免正则跨条目。
        end = (
            markers[index + 1].start()
            if index + 1 < len(markers)
            else min(len(page), start + 8_000)
        )
        block = page[start:end]
        title = _first(r'<a[^>]*data-hook="review-title"[^>]*>([^<]+)</a>', block)
        if not title:
            continue
        # 新旧两种评论页评分标记：星级文本直接可见，或 class 里的 a-star-N。
        rating_text = _first(
            r'<i[^>]*a-icon-star[^>]*>([^<]+)</i>',
            block,
        ) or _first(
            r'<i[^>]*a-icon-alt[^>]*>([^<]+)</i>',
            block,
        )
        rating = _number(rating_text)
        if rating is None:
            rating = _rating_from_class(
                _first(r'<i[^>]*class="([^"]+)"[^>]*>', block) or ""
            )
        body = _first(
            r'<span[^>]*data-hook="review-body"[^>]*>([\s\S]*?)</span>',
            block,
        )
        author = _first(
            r'<a[^>]*data-hook="review-author"[^>]*>([^<]+)</a>',
            block,
        ) or _first(
            r'<span[^>]*class="a-profile-name"[^>]*>([^<]+)</span>',
            block,
        )
        date = _first(r'<span[^>]*data-hook="review-date"[^>]*>([^<]+)</span>', block)
        verified = _verified(block)
        if not body and not title:
            continue
        rows.append(
            {
                "id": f"amazon-review-{asin}-{len(rows) + 1}",
                "asin": asin,
                "rating": rating,
                "title": title[:240],
                "text": body[:2_000],
                "author": author[:80],
                "date": date[:60],
                "verifiedPurchase": verified,
                "isDemo": False,
            }
        )
        if len(rows) >= limit:
            break
    return rows


async def _fetch_review_pages(
    asin: str,
    marketplace: Marketplace,
    pages: int,
) -> list[dict[str, Any]]:
    """抓取评论页并按页合并解析结果，去重后返回。"""

    rows: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for page_number in range(1, pages + 1):
        url = (
            f"https://{marketplace.amazon_domain}/product-reviews/{quote(asin)}"
            f"?pageNumber={page_number}"
        )
        async with httpx.AsyncClient(
            timeout=DEFAULT_TIMEOUT,
            follow_redirects=True,
        ) as client:
            response = await client.get(url, headers=_CRAWLER_HEADERS)
            response.raise_for_status()
            page = response.text
        parsed = _parse_reviews_html(page, asin, limit=12)
        for item in parsed:
            if item["id"] in seen_ids:
                continue
            seen_ids.add(item["id"])
            rows.append(item)
        if len(parsed) < 5:
            # 当前页明显不足一页，通常已到末页，提前停止。
            break
    return rows


async def fetch_amazon_reviews(
    asin: str,
    marketplace: Marketplace,
    credentials: dict[str, str],
    limit: int = 30,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """抓取一个 ASIN 的公开评论，返回 (reviews, diagnostic)。"""

    del credentials  # 评论页爬取目前不需要凭据，保留参数以对齐数据源接口。
    started = time.perf_counter()
    if os.getenv("COMMERCE_AMAZON_CRAWLER", "1").strip().lower() not in {
        "1",
        "true",
        "on",
    }:
        raise RuntimeError("Amazon 公开爬虫已通过 COMMERCE_AMAZON_CRAWLER 关闭")
    rows = await _fetch_review_pages(asin, marketplace, pages=REVIEW_PAGES)
    if not rows:
        raise RuntimeError(
            "Amazon 评论页未解析到评论（可能被反爬拦截或页面结构变化）"
        )
    rows = rows[:limit]
    return rows, {
        "provider": "amazon-reviews",
        "mode": "crawler",
        "latencyMs": round((time.perf_counter() - started) * 1000),
        "parsedResultCount": len(rows),
    }


__all__ = ["fetch_amazon_reviews"]
