"""TikTok Shop 开放平台商品搜索采集客户端。

流程：client_key/client_secret 换取 access_token（/api/v2/token/get），
再调用 /product/search（v1）搜索商品并标准化。凭据缺失或接口失败时
返回空结果并抛出可被上层捕获的 RuntimeError，不中断整条流水线。
"""

from __future__ import annotations

import hashlib
import time
from typing import Any

import httpx

BASE_URL = "https://open-api.tiktokglobalshop.com"
TOKEN_PATH = "/api/v2/token/get"
SEARCH_PATH = "/product/search"
DEFAULT_TIMEOUT = httpx.Timeout(30.0, connect=15.0)


def _sign_sha256(client_secret: str, timestamp: str, path: str) -> str:
    """按 TikTok Shop 开放平台规范生成请求签名（SHA256）。"""

    raw = f"{client_secret}{timestamp}{path}".encode()
    return hashlib.sha256(raw).hexdigest()


async def fetch_tiktok_access_token(
    client_key: str,
    client_secret: str,
) -> str:
    """用 app 凭据换取商家访问令牌。"""

    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, trust_env=False) as client:
        response = await client.post(
            f"{BASE_URL}{TOKEN_PATH}",
            data={
                "app_key": client_key,
                "app_secret": client_secret,
                "grant_type": "client_credentials",
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        response.raise_for_status()
        payload = response.json()
    code = payload.get("code")
    if code not in (0, "0"):
        raise RuntimeError(
            f"TikTok Shop 换取令牌失败：{payload.get('message') or payload.get('error')}"
        )
    data = payload.get("data") or {}
    token = str(data.get("access_token") or "")
    if not token:
        raise RuntimeError("TikTok Shop 未返回 access_token")
    return token


def _normalize(item: dict[str, Any], index: int) -> dict[str, Any] | None:
    """把 TikTok Shop 商品标准化为统一的 observation。"""

    product_id = str(item.get("id") or item.get("product_id") or "")
    title = str(item.get("title") or item.get("name") or "").strip()
    if not product_id or not title:
        return None
    price = item.get("price") or {}
    try:
        price_value = float(price.get("value") or item.get("price_value") or 0)
    except (TypeError, ValueError):
        price_value = 0.0
    currency = str(price.get("currency") or item.get("currency") or "USD")
    return {
        "id": f"tiktok-{product_id}",
        "title": title[:200],
        "url": str(item.get("product_url") or item.get("url") or ""),
        "domain": "tiktok.com",
        "snippet": str(item.get("description") or "")[:300],
        "resultType": "shopping",
        "position": index + 1,
        "price": price_value,
        "currency": currency,
        "rating": None,
        "reviewCount": None,
        "merchant": str(item.get("seller_name") or "TikTok Shop 卖家")[:120],
        "provider": "tiktok-shop",
        "isDemo": False,
    }


async def search_tiktok_shop(
    query: str,
    client_key: str,
    client_secret: str,
    merchant_id: str,
    access_token: str,
    limit: int = 12,
) -> list[dict[str, Any]]:
    """搜索 TikTok Shop 商品，返回标准化 observation 列表。"""

    timestamp = str(int(time.time()))
    path = SEARCH_PATH
    params: dict[str, Any] = {
        "keyword": query,
        "page_size": max(1, min(limit, 50)),
        "page_no": 1,
        "shop_cipher": merchant_id,
    }
    url = f"{BASE_URL}{path}"
    headers = {
        "x-tts-access-token": access_token,
        "x-tts-timestamp": timestamp,
        "x-tts-signature": _sign_sha256(client_secret, timestamp, path),
        "x-tts-sign-method": "HMACSHA256",
    }
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, trust_env=False) as client:
        response = await client.post(url, params=params, json=params, headers=headers)
        response.raise_for_status()
        payload = response.json()
    code = payload.get("code")
    if code not in (0, "0"):
        raise RuntimeError(
            f"TikTok Shop 商品搜索失败：{payload.get('message') or payload.get('error')}"
        )
    data = payload.get("data") or {}
    products = data.get("products") or data.get("items") or payload.get("products") or []
    return [
        item
        for index, raw in enumerate(products)
        if (item := _normalize(raw, index)) is not None
    ][:limit]


__all__ = ["fetch_tiktok_access_token", "search_tiktok_shop"]
