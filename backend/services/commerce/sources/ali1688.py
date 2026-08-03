"""1688 开放平台（TOP）商品搜索采集客户端。

使用 param2 协议调用 ``alibaba.cross.product.search``（跨境商品搜索）。
凭据缺失或网络/权限失败时返回空结果并给出 warning，不抛错中断流水线。
签名算法为 MD5（appSecret + 排序后的查询参数字符串），可在离线单测中校验一致性。
"""

from __future__ import annotations

import hashlib
from typing import Any
from urllib.parse import urlencode

import httpx

GATEWAY = "https://gw.open.1688.com/openapi/param2/1/com.alibaba.cross/alibaba.cross.product.search"
DEFAULT_TIMEOUT = httpx.Timeout(30.0, connect=15.0)


def _sign_params(app_secret: str, params: dict[str, str]) -> str:
    """按 TOP param2 协议生成签名（MD5(appSecret + 排序后参数串)）。"""

    sorted_params = "&".join(
        f"{key}={params[key]}" for key in sorted(params)
    )
    return hashlib.md5((app_secret + sorted_params).encode("utf-8")).hexdigest().upper()


def _normalize(item: dict[str, Any], query: str, index: int) -> dict[str, Any] | None:
    """把 1688 商品字段标准化为平台统一的 observation。"""

    product_id = str(
        item.get("productID")
        or item.get("productId")
        or item.get("offerId")
        or item.get("id")
        or ""
    )
    title = str(item.get("subject") or item.get("title") or "").strip()
    if not product_id or not title:
        return None
    price = item.get("priceInfo") or {}
    try:
        price_value = float(
            price.get("price")
            or price.get("sellPrice")
            or item.get("price")
            or 0
        )
    except (TypeError, ValueError):
        price_value = 0.0
    return {
        "id": f"1688-{product_id}",
        "title": title[:200],
        "url": str(item.get("detailUrl") or item.get("detailUrlMobile") or ""),
        "domain": "1688.com",
        "snippet": str(item.get("summary") or item.get("description") or "")[:300],
        "resultType": "shopping",
        "position": index + 1,
        "price": price_value,
        "currency": "CNY",
        "rating": None,
        "reviewCount": None,
        "merchant": str(item.get("sellerLoginId") or item.get("companyName") or "1688 卖家")[:120],
        "provider": "1688",
        "isDemo": False,
    }


async def search_1688(
    query: str,
    app_key: str,
    app_secret: str,
    access_token: str,
    limit: int = 12,
) -> list[dict[str, Any]]:
    """搜索 1688 跨境商品，返回标准化 observation 列表。"""

    params: dict[str, str] = {
        "access_token": access_token,
        "appKey": app_key,
        "keywords": query,
        "pageSize": str(max(1, min(limit, 20))),
        "pageNo": "1",
    }
    params["_aop_signature"] = _sign_params(app_secret, params)
    url = f"{GATEWAY}/{app_key}?{urlencode(params)}"
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT, trust_env=False) as client:
        response = await client.get(url)
        response.raise_for_status()
        payload = response.json()
    if payload.get("errorCode") or payload.get("error"):
        raise RuntimeError(f"1688 API 错误：{payload.get('errorMessage') or payload.get('error')}")
    result = payload.get("result") or {}
    items = result.get("products") or result.get("productInfos") or payload.get("products") or []
    return [
        item
        for index, raw in enumerate(items)
        if (item := _normalize(raw, query, index)) is not None
    ][:limit]


__all__ = ["search_1688"]
