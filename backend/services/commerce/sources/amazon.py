"""Amazon 市场研究数据源：SP-API 凭据优先，未配置时回退公开页爬虫。

凭据齐全 → Amazon Selling Partner API Catalog Search（真实 ASIN/标题）；
未配置 → Amazon 公开搜索页爬虫（标题/价格/评分/评论数）；
任一路径失败都以异常上抛，由上层降级到 TalorData 或标记 warning，不中断流水线。
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

LWA_TOKEN_URL = "https://api.amazon.com/auth/o2/token"
SP_API_ENDPOINTS = {
    "NA": "https://sellingpartnerapi-na.amazon.com",
    "EU": "https://sellingpartnerapi-eu.amazon.com",
    "FE": "https://sellingpartnerapi-fe.amazon.com",
}
_SP_REGION = {
    "US": "NA",
    "CA": "NA",
    "UK": "EU",
    "DE": "EU",
    "FR": "EU",
    "IT": "EU",
    "ES": "EU",
    "JP": "FE",
}
_CRAWLER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Accept": "text/html,application/xhtml+xml",
}
DEFAULT_TIMEOUT = httpx.Timeout(20.0, connect=10.0)


def _region(marketplace: Marketplace) -> str:
    """按市场代码返回 SP-API 区域端点。"""

    return _SP_REGION.get(marketplace.code.upper(), "NA")


async def exchange_access_token(
    client_id: str,
    client_secret: str,
    refresh_token: str,
) -> str:
    """通过 LWA 换取 SP-API 的短期 access_token。"""

    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        response = await client.post(
            LWA_TOKEN_URL,
            data={
                "grant_type": "refresh_token",
                "client_id": client_id,
                "client_secret": client_secret,
                "refresh_token": refresh_token,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        response.raise_for_status()
        payload = response.json()
    token = str(payload.get("access_token") or "")
    if not token:
        raise RuntimeError("Amazon LWA 未返回 access_token")
    return token


def _normalize(
    item: dict[str, Any],
    marketplace: Marketplace,
    provider: str,
) -> dict[str, Any] | None:
    """把 SP-API / 爬虫条目标准化为平台统一 observation。"""

    asin = str(item.get("asin") or "")
    title = str(item.get("title") or "").strip()
    if not asin or not title:
        return None
    snippet = str(item.get("snippet") or "")[:240]
    price = item.get("price")
    currency = (
        marketplace.currency
        if isinstance(price, (int, float)) and price > 0
        else None
    )
    return {
        "id": f"amazon-{asin}",
        "title": title[:240],
        "url": f"https://{marketplace.amazon_domain}/dp/{asin}",
        "domain": marketplace.amazon_domain,
        "snippet": snippet or None,
        "resultType": "shopping",
        "position": int(item.get("position") or 0) or None,
        "price": price if isinstance(price, (int, float)) and price > 0 else None,
        "currency": currency,
        "rating": item.get("rating"),
        "reviewCount": item.get("reviewCount"),
        "merchant": item.get("merchant") or "Amazon",
        "provider": provider,
    }


async def _search_sp_api(
    query: str,
    marketplace: Marketplace,
    client_id: str,
    client_secret: str,
    refresh_token: str,
    limit: int,
) -> list[dict[str, Any]]:
    """通过 SP-API Catalog Search 搜索商品。"""

    token = await exchange_access_token(client_id, client_secret, refresh_token)
    base = SP_API_ENDPOINTS[_region(marketplace)]
    marketplace_id = marketplace.sp_api_marketplace_id or "ATVPDKIKX0DER"
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        response = await client.get(
            f"{base}/catalog/2022-04-01/items",
            params={"keywords": query, "marketplaceIds": marketplace_id},
            headers={
                "x-amz-access-token": token,
                "x-amz-marketplace-id": marketplace_id,
            },
        )
        response.raise_for_status()
        payload = response.json()
    rows: list[dict[str, Any]] = []
    for index, item in enumerate((payload.get("items") or [])[:limit]):
        if not isinstance(item, dict):
            continue
        summaries = item.get("summaries") or []
        title = ""
        snippet = ""
        if summaries and isinstance(summaries[0], dict):
            title = str(summaries[0].get("itemName") or "")
            snippet = str(summaries[0].get("websiteDisplayName") or "")
        normalized = _normalize(
            {
                "asin": item.get("asin"),
                "title": title,
                "snippet": snippet,
                "position": index + 1,
            },
            marketplace,
            "amazon-sp-api",
        )
        if normalized:
            rows.append(normalized)
    return rows


def _first(pattern: str, text: str) -> str:
    """返回第一个正则命中的 HTML 文本（去实体、去标签）。"""

    match = re.search(pattern, text, re.DOTALL | re.IGNORECASE)
    if not match:
        return ""
    value = html.unescape(match.group(1)).strip()
    return re.sub(r"<[^>]+>", "", value).strip()


def _number(value: str) -> float | None:
    """把 "$12.99" / "4.6 out of 5 stars" 转成数字。"""

    match = re.search(r"([0-9]+(?:\.[0-9]+)?)", value.replace(",", ""))
    if not match:
        return None
    try:
        number = float(match.group(1))
    except ValueError:
        return None
    return number if number > 0 else None


def _parse_search_html(
    page: str,
    marketplace: Marketplace,
    limit: int,
) -> list[dict[str, Any]]:
    """从 Amazon 搜索页 HTML 中解析商品条目（无第三方解析库，正则兜底）。"""

    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    markers = list(
        re.finditer(
            r'data-asin="([A-Z0-9]{10})"[^>]*data-component-type="s-search-result"',
            page,
        )
    )
    for index, marker in enumerate(markers):
        asin = marker.group(1)
        if asin in seen:
            continue
        start = marker.start()
        end = (
            markers[index + 1].start()
            if index + 1 < len(markers)
            else start + 4_000
        )
        block = page[start:end]
        title = _first(r"<h2[^>]*>.*?<span[^>]*>(.*?)</span>", block) or _first(
            r"<h2[^>]*>(.*?)</h2>", block
        )
        if not title:
            continue
        seen.add(asin)
        price_text = _first(
            r'<span class="a-price"[^>]*>.*?<span class="a-offscreen">([^<]+)</span>',
            block,
        )
        rating_text = _first(r'<span class="a-icon-alt">([^<]+)</span>', block)
        reviews_text = _first(
            r'<span class="a-size-base s-underline-text">([^<]+)</span>',
            block,
        )
        normalized = _normalize(
            {
                "asin": asin,
                "title": title,
                "position": len(rows) + 1,
                "price": _number(price_text),
                "rating": _number(rating_text),
                "reviewCount": _number(reviews_text),
            },
            marketplace,
            "amazon-public-page",
        )
        if normalized:
            rows.append(normalized)
        if len(rows) >= limit:
            break
    return rows


async def _search_public_crawler(
    query: str,
    marketplace: Marketplace,
    limit: int,
) -> list[dict[str, Any]]:
    """抓取 Amazon 公开搜索页并解析商品条目。"""

    url = f"https://{marketplace.amazon_domain}/s?k={quote(query)}"
    async with httpx.AsyncClient(
        timeout=DEFAULT_TIMEOUT,
        follow_redirects=True,
    ) as client:
        response = await client.get(url, headers=_CRAWLER_HEADERS)
        response.raise_for_status()
        page = response.text
    rows = _parse_search_html(page, marketplace, limit)
    if not rows:
        raise RuntimeError(
            "Amazon 搜索页未解析到商品（可能被反爬拦截或页面结构变化）"
        )
    return rows


async def search_amazon(
    query: str,
    marketplace: Marketplace,
    credentials: dict[str, str],
    limit: int = 8,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """按降级链采集 Amazon 数据：SP-API 凭据 → 公开页爬虫。"""

    started = time.perf_counter()
    client_id = credentials.get("amazon_client_id")
    client_secret = credentials.get("amazon_client_secret")
    refresh_token = credentials.get("amazon_refresh_token")
    if client_id and client_secret and refresh_token:
        mode = "sp-api"
        rows = await _search_sp_api(
            query,
            marketplace,
            client_id,
            client_secret,
            refresh_token,
            limit,
        )
    else:
        mode = "crawler"
        if os.getenv("COMMERCE_AMAZON_CRAWLER", "1").strip().lower() not in {
            "1",
            "true",
            "on",
        }:
            raise RuntimeError("Amazon 公开爬虫已通过 COMMERCE_AMAZON_CRAWLER 关闭")
        rows = await _search_public_crawler(query, marketplace, limit)
    latency_ms = round((time.perf_counter() - started) * 1000)
    return rows, {
        "provider": "amazon",
        "mode": mode,
        "latencyMs": latency_ms,
        "parsedResultCount": len(rows),
    }


__all__ = [
    "exchange_access_token",
    "search_amazon",
]
