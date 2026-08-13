"""TalorData SERP 请求与响应兼容层。"""

from __future__ import annotations

import hashlib
import json
import re
import time
from collections.abc import Iterable
from typing import Any
from urllib.parse import urlparse

import httpx

from backend.services.commerce.marketplaces import Marketplace

CURRENT_ENDPOINT = "https://serpapi.talordata.net/serp/v1/request"
COMPAT_ENDPOINT = "https://serpapi.talordata.net/request"
RESULT_KEYS = {
    "organic",
    "organic_results",
    "web_results",
    "results",
    "items",
    "shopping",
    "shopping_results",
    "inline_shopping_results",
    "products",
    "sponsored_results",
    "ads",
    "paid_results",
    "related",
    "related_searches",
    "questions",
    "people_also_ask",
}


def _record(value: Any) -> dict[str, Any] | None:
    """当输入是字典时返回输入，否则返回 ``None``。"""

    return value if isinstance(value, dict) else None


def _parse_nested_json(value: Any) -> Any:
    """尝试解析响应中被再次编码成字符串的 JSON。"""

    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if not stripped.startswith(("{", "[")):
        return value
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return value


def _looks_like_result(item: dict[str, Any]) -> bool:
    """根据常见字段判断字典是否像一条搜索结果。"""

    identity_keys = {"title", "name", "product_title", "link", "url", "snippet", "question"}
    return any(key in item for key in identity_keys)


def collect_result_rows(payload: Any) -> list[tuple[str, dict[str, Any]]]:
    """递归提取 TalorData 不同版本响应中的搜索结果数组。

    返回值中的第一个元素是原容器名，用于判断 organic、shopping 或广告类型；
    第二个元素是单条原始结果字典。
    """

    rows: list[tuple[str, dict[str, Any]]] = []
    seen: set[int] = set()

    def visit(value: Any, container: str, depth: int) -> None:
        """递归访问嵌套数据，并避免循环引用和异常深度。"""

        if depth > 8:
            return
        value = _parse_nested_json(value)
        if isinstance(value, list):
            for child in value:
                if isinstance(child, dict) and _looks_like_result(child):
                    rows.append((container or "results", child))
                else:
                    visit(child, container, depth + 1)
            return
        if not isinstance(value, dict):
            return
        object_id = id(value)
        if object_id in seen:
            return
        seen.add(object_id)
        for raw_key, child in value.items():
            key = raw_key.lower()
            next_container = raw_key if key in RESULT_KEYS else container
            if isinstance(child, list) and key in RESULT_KEYS:
                visit(child, raw_key, depth + 1)
            elif isinstance(child, dict):
                if key in RESULT_KEYS and _looks_like_result(child):
                    rows.append((raw_key, child))
                visit(child, next_container, depth + 1)
            elif isinstance(child, str):
                parsed = _parse_nested_json(child)
                if parsed is not child:
                    visit(parsed, next_container, depth + 1)

    visit(payload, "", 0)
    return rows


def _first_text(item: dict[str, Any], keys: Iterable[str]) -> str | None:
    """返回候选字段中的第一个非空字符串。"""

    for key in keys:
        value = item.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _number(value: Any) -> float | None:
    """把数字或带符号文本转换成浮点数。"""

    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    cleaned = re.sub(r"[^0-9.\-]", "", value.replace(",", ""))
    try:
        return float(cleaned) if cleaned else None
    except ValueError:
        return None


def _first_number(item: dict[str, Any], keys: Iterable[str]) -> float | None:
    """返回候选字段中的第一个可解析数字。"""

    for key in keys:
        result = _number(item.get(key))
        if result is not None:
            return result
    return None


def _result_type(container: str) -> str:
    """根据结果容器名推断前端展示类型。"""

    normalized = container.lower()
    if "shop" in normalized or "product" in normalized:
        return "shopping"
    if any(word in normalized for word in ("ad", "paid", "sponsor")):
        return "ad"
    if any(word in normalized for word in ("related", "question", "people")):
        return "related"
    if any(word in normalized for word in ("organic", "web")):
        return "organic"
    return "other"


def _stable_id(seed: str) -> str:
    """把结果内容转换成稳定且不含隐私的短标识。"""

    digest = hashlib.sha1(seed.encode("utf-8"), usedforsecurity=False).hexdigest()[:12]
    return f"SERP-{digest}"


def _is_google_shopping_echo(url: str) -> bool:
    """判断 URL 是否是 Google 购物 SERP 回链（无稳定商品详情页）。

    Google Shopping 的商品信息内嵌在搜索页里，TalorData 返回的 ``link``
    常是 ``webhp?ibp=oshop`` 形式的搜索界面回链（``prds`` 参数甚至全为空），
    点开只会回到购物搜索页。这类链接应清空，避免前端渲染出无效跳转。
    """

    lowered = url.lower()
    return "google." in lowered and ("webhp" in lowered or "ibp=oshop" in lowered)


def normalize_observation(
    container: str, item: dict[str, Any], marketplace: Marketplace
) -> dict[str, Any] | None:
    """把单条原始搜索结果转换成前端统一市场观察结构。"""

    title = _first_text(item, ("title", "name", "product_title", "question", "query", "text"))
    snippet = _first_text(item, ("snippet", "description", "answer", "content"))
    display_title = title or snippet
    if not display_title:
        return None
    raw_url = _first_text(item, ("link", "url", "product_link", "redirect_link"))
    url = None if raw_url and _is_google_shopping_echo(raw_url) else raw_url
    domain = None
    if url:
        try:
            domain = urlparse(url).hostname
            domain = domain.removeprefix("www.") if domain else None
        except ValueError:
            domain = None
    price = _first_number(
        item,
        ("extracted_price", "price_value", "price_numeric", "min_price", "price", "current_price"),
    )
    merchant = _first_text(item, ("merchant", "seller", "source", "store", "domain")) or domain
    # 用原始链接参与稳定 ID 计算，保证同一条结果在不同轮次去重时不漂移。
    seed = "|".join((container, display_title, raw_url or snippet or ""))
    return {
        "id": _stable_id(seed),
        "title": display_title,
        "url": url,
        "domain": domain,
        "snippet": snippet,
        "resultType": _result_type(container),
        "position": _first_number(item, ("position", "rank", "index")),
        "price": price,
        "currency": marketplace.currency if price is not None else None,
        "rating": _first_number(item, ("rating", "stars", "score")),
        "reviewCount": _first_number(item, ("reviews", "review_count", "reviews_count", "ratings", "rating_count")),
        "merchant": merchant,
        "provider": "talordata-market",
    }


async def _request_endpoint(
    endpoint: str,
    token: str,
    query: str,
    marketplace: Marketplace,
    engine: str,
    sample_size: int,
) -> tuple[Any, int]:
    """向单个 TalorData 兼容地址发送表单请求。"""

    language, country = marketplace.locale.split("_", 1)
    form = {
        "engine": engine,
        "q": query,
        "device": "desktop",
        "location": marketplace.country_name,
        "num": str(max(1, min(sample_size, 100))),
        "json": "1",
        "gl": country.lower(),
        "hl": language.lower(),
    }
    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=45.0, follow_redirects=True) as client:
            response = await client.post(
                endpoint,
                data=form,
                headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
            )
    except httpx.HTTPError as exc:
        raise RuntimeError(f"TalorData 网络连接失败：{exc}") from exc
    latency_ms = round((time.perf_counter() - started) * 1000)
    try:
        payload = response.json()
    except ValueError:
        payload = {"message": response.text[:800]}
    if response.is_error:
        message = payload.get("message") if isinstance(payload, dict) else None
        error = RuntimeError(f"TalorData 请求失败（HTTP {response.status_code}）{f'：{message}' if message else ''}")
        error.status_code = response.status_code
        raise error
    return payload, latency_ms


async def request_search(
    token: str,
    query: str,
    marketplace: Marketplace,
    engine: str = "google",
    sample_size: int = 12,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """调用 TalorData，并返回标准化观察列表和诊断信息。"""

    errors: list[str] = []
    for endpoint in (CURRENT_ENDPOINT, COMPAT_ENDPOINT):
        try:
            payload, latency_ms = await _request_endpoint(
                endpoint, token, query, marketplace, engine, sample_size
            )
            observations = [
                normalized
                for container, item in collect_result_rows(payload)
                if (normalized := normalize_observation(container, item, marketplace))
            ]
            return observations, {
                "endpoint": endpoint,
                "latencyMs": latency_ms,
                "parsedResultCount": len(observations),
            }
        except RuntimeError as exc:
            errors.append(f"{endpoint}: {exc}")
            status_code = getattr(exc, "status_code", None)
            if status_code not in {401, 404, 405}:
                break
    raise RuntimeError("；".join(errors) or "TalorData 请求失败")
