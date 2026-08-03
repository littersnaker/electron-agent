"""Commerce 市场研究与 Listing 的 LangGraph 管线。

保留现有确定性函数与 SSE 契约（COMMERCE_PROGRESS / COMMERCE_REPORT /
COMMERCE_LISTING / USAGE），把流程改为节点化编排：
- 研究：意图识别 → 多源并行采集 → Demo 兜底 → 归一化 → 分析 → 报告
- Listing：意图 → 档案收集 → 关键词 → 初稿 → 校验（失败回炉重写一次）→ 报告
"""

from __future__ import annotations

import operator
import random
from datetime import UTC, datetime
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from backend.schemas.commerce import CommerceRequest
from backend.services.commerce.analytics import (
    build_insights,
    calculate_metrics,
    observations_to_products,
    resolve_category,
)
from backend.services.commerce.listing import _draft, _keywords, _validate
from backend.services.commerce.marketplaces import get_marketplace
from backend.services.commerce.sources.ali1688 import search_1688
from backend.services.commerce.sources.tiktokshop import (
    fetch_tiktok_access_token,
    search_tiktok_shop,
)
from backend.services.commerce.talordata import request_search


def _demo_observations(query: str, currency: str, count: int = 12) -> list[dict[str, Any]]:
    """生成明确标注的稳定演示样本（与旧实现一致）。"""

    seed = sum(ord(char) for char in query)
    randomizer = random.Random(seed)
    observations: list[dict[str, Any]] = []
    for index in range(count):
        price = round(randomizer.uniform(12, 85), 2)
        observations.append(
            {
                "id": f"DEMO-{seed:x}-{index + 1}",
                "title": f"{query[:32]} 示例商品 {index + 1}",
                "url": None,
                "domain": f"demo{index % 5 + 1}.example",
                "snippet": "这是离线演示样本，不代表任何真实平台商品或销量。",
                "resultType": "shopping",
                "position": index + 1,
                "price": price,
                "currency": currency,
                "rating": round(randomizer.uniform(3.7, 4.8), 1),
                "reviewCount": randomizer.randint(20, 2600),
                "merchant": f"Demo Seller {index % 5 + 1}",
                "provider": "demo-market",
                "isDemo": True,
            }
        )
    return observations


def _last_write(_current: Any, update: Any) -> Any:
    """并行分支写同一键时采用“最后一次写入”的归并策略。"""

    return update


class ResearchState(TypedDict):
    """市场研究整体状态。"""

    query: str
    marketplace: dict[str, str]
    sample_size: int
    credentials: dict[str, str]
    category: dict[str, Any]
    observations: Annotated[list[dict[str, Any]], operator.add]
    warnings: Annotated[list[str], operator.add]
    diagnostic: Annotated[dict[str, Any], _last_write]
    products: list[dict[str, Any]]
    metrics: dict[str, Any]
    insights: dict[str, Any]
    report: dict[str, Any]
    is_demo: bool
    platform_status: Annotated[list[dict[str, Any]], operator.add]


def build_research_graph(body: CommerceRequest, credentials: dict[str, str]):
    """构建市场研究 LangGraph。"""

    marketplace = get_marketplace(body.marketplace)
    marketplace_meta = {
        "key": marketplace.code,
        "label": marketplace.label,
        "currency": marketplace.currency,
        "locale": getattr(marketplace, "locale", ""),
    }

    async def intent_node(state: ResearchState) -> dict[str, Any]:
        category = resolve_category(state["query"])
        return {"category": category}

    def after_intent(state: ResearchState) -> list[Send] | str:
        token = state["credentials"].get("talordata")
        keywords = (state["category"].get("keywords") or [])[:2] or [state["query"]]
        sends: list[Send] = []
        if token:
            sends.extend(
                Send(
                    "search_source",
                    {
                        "keyword": keyword,
                        "engine": engine,
                        "token": token,
                        "marketplace": marketplace,
                        "sample": max(4, min(body.sample_size // 2, 12)),
                    },
                )
                for keyword in keywords
                for engine in ("google", "google_shopping")
            )
        creds = state["credentials"]
        if creds.get("tiktok_client_key") and creds.get("tiktok_client_secret"):
            sends.append(
                Send(
                    "platform_source",
                    {
                        "provider": "tiktok-shop",
                        "query": body.query,
                        "limit": max(4, min(body.sample_size // 2, 12)),
                        "credentials": dict(state["credentials"]),
                    },
                )
            )
        if creds.get("alibaba_1688_app_key") and creds.get("alibaba_1688_app_secret"):
            sends.append(
                Send(
                    "platform_source",
                    {
                        "provider": "1688",
                        "query": body.query,
                        "limit": max(4, min(body.sample_size // 2, 12)),
                        "credentials": dict(state["credentials"]),
                    },
                )
            )
        if not sends:
            return "demo_fill"
        return sends

    async def search_source(payload: dict[str, Any]) -> dict[str, Any]:
        try:
            items, current_diagnostic = await request_search(
                payload["token"],
                payload["keyword"],
                payload["marketplace"],
                payload["engine"],
                payload["sample"],
            )
            return {
                "observations": items,
                "diagnostic": current_diagnostic,
            }
        except RuntimeError as exc:
            return {"warnings": [str(exc)]}

    async def platform_source(payload: dict[str, Any]) -> dict[str, Any]:
        """并行采集 TikTok Shop / 1688 官方 API。"""

        provider = payload["provider"]
        query = payload["query"]
        limit = payload["limit"]
        creds = payload["credentials"]
        try:
            if provider == "tiktok-shop":
                token = await fetch_tiktok_access_token(
                    creds["tiktok_client_key"],
                    creds["tiktok_client_secret"],
                )
                items = await search_tiktok_shop(
                    query,
                    creds["tiktok_client_key"],
                    creds["tiktok_client_secret"],
                    creds.get("tiktok_merchant_id") or "",
                    token,
                    limit,
                )
            else:
                items = await search_1688(
                    query,
                    creds["alibaba_1688_app_key"],
                    creds["alibaba_1688_app_secret"],
                    creds.get("alibaba_1688_access_token") or "",
                    limit,
                )
            return {
                "observations": items,
                "platform_status": [
                    {
                        "provider": provider,
                        "status": "collected" if items else "empty",
                        "sampleSize": len(items),
                    }
                ],
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "warnings": [f"{provider} 采集失败：{exc}"],
                "platform_status": [
                    {
                        "provider": provider,
                        "status": "failed",
                        "sampleSize": 0,
                        "message": str(exc)[:200],
                    }
                ],
            }

    async def demo_fill(state: ResearchState) -> dict[str, Any]:
        if state.get("observations"):
            return {}
        return {
            "observations": _demo_observations(
                state["query"],
                marketplace_meta["currency"],
                min(body.sample_size, 16),
            ),
            "warnings": [
                "真实公开数据源未配置、不可用或没有返回可解析结果，本轮使用明确标记的演示数据。"
            ],
            "is_demo": True,
        }

    async def normalize_node(state: ResearchState) -> dict[str, Any]:
        observations = state.get("observations") or []
        unique = {item["id"]: item for item in observations}
        observations = list(unique.values())[: body.sample_size]
        products = observations_to_products(observations)
        return {"observations": observations, "products": products}

    async def analyze_node(state: ResearchState) -> dict[str, Any]:
        observations = state.get("observations") or []
        products = state.get("products") or []
        is_demo = bool(state.get("is_demo") or not observations)
        metrics = calculate_metrics(
            observations,
            products,
            marketplace_meta["currency"],
        )
        insights = build_insights(metrics, is_demo)
        return {"metrics": metrics, "insights": insights, "is_demo": is_demo}

    async def report_node(state: ResearchState) -> dict[str, Any]:
        observations = state.get("observations") or []
        is_demo = bool(state.get("is_demo") or not observations)
        source_status = "demo" if is_demo else "collected"
        provider = "demo-market" if is_demo else "talordata-market"
        report = {
            "version": 3,
            "runMode": "demo" if is_demo else "market-intelligence",
            "generatedAt": datetime.now(UTC).isoformat(),
            "query": body.query,
            "marketplace": body.marketplace,
            "marketplaceLabel": marketplace_meta["label"],
            "category": state.get("category"),
            "products": state.get("products") or [],
            "observations": observations,
            "metrics": state.get("metrics"),
            "insights": state.get("insights"),
            "dataSource": {
                "provider": provider,
                "quality": "low" if is_demo else "medium",
                "description": "离线演示样本" if is_demo else "TalorData 公开 SERP / Shopping 搜索样本",
            },
            "sources": [
                {
                    "id": "market-search",
                    "label": "公开市场搜索",
                    "status": source_status,
                    "provider": provider,
                    "quality": "low" if is_demo else "medium",
                    "sampleSize": len(observations),
                    "coverage": ["标题", "结果来源", "价格（若公开）", "评分（若公开）"],
                    "summary": "本轮使用演示数据。" if is_demo else "已取得并解析公开市场搜索结果。",
                    "warnings": list(state.get("warnings") or []),
                    "metrics": {"observationCount": len(observations)},
                },
                *[
                    {
                        "id": status["provider"],
                        "label": {
                            "tiktok-shop": "TikTok Shop",
                            "1688": "1688",
                        }.get(status["provider"], status["provider"]),
                        "status": status.get("status", "unconfigured"),
                        "quality": (
                            "low"
                            if status.get("status") == "collected"
                            else "unavailable"
                        ),
                        "sampleSize": int(status.get("sampleSize") or 0),
                        "coverage": (
                            ["标题", "价格", "商家"]
                            if status.get("status") == "collected"
                            else []
                        ),
                        "summary": (
                            status.get("message")
                            or (
                                "已采集官方 API 商品样本。"
                                if status.get("status") == "collected"
                                else "未返回可解析商品。"
                            )
                        ),
                        "warnings": [],
                    }
                    for status in (state.get("platform_status") or [])
                ],
                *[
                    {
                        "id": source_id,
                        "label": label,
                        "status": "unconfigured",
                        "quality": "unavailable",
                        "sampleSize": 0,
                        "coverage": [],
                        "summary": "未配置该平台凭据。",
                        "warnings": [],
                    }
                    for source_id, label in (
                        ("amazon", "Amazon"),
                        ("keepa", "Keepa"),
                        ("tiktok-shop", "TikTok Shop"),
                        ("temu", "Temu"),
                        ("1688", "1688"),
                    )
                    if source_id
                    not in {item.get("provider") for item in (state.get("platform_status") or [])}
                ],
            ],
            "confidenceScore": 28 if is_demo else min(85, 45 + len(observations) * 2),
            "warnings": list(state.get("warnings") or []),
            "diagnostic": state.get("diagnostic") or {},
        }
        return {"report": report}

    graph = StateGraph(ResearchState)
    graph.add_node("intent", intent_node)
    graph.add_node("search_source", search_source)
    graph.add_node("platform_source", platform_source)
    graph.add_node("demo_fill", demo_fill)
    graph.add_node("normalize", normalize_node)
    graph.add_node("analyze", analyze_node)
    graph.add_node("report", report_node)
    graph.add_edge(START, "intent")
    graph.add_conditional_edges(
        "intent",
        after_intent,
        ["search_source", "platform_source", "demo_fill"],
    )
    graph.add_edge("search_source", "demo_fill")
    graph.add_edge("platform_source", "demo_fill")
    graph.add_edge("demo_fill", "normalize")
    graph.add_edge("normalize", "analyze")
    graph.add_edge("analyze", "report")
    graph.add_edge("report", END)
    return graph.compile()


class ListingState(TypedDict):
    """Listing 生成整体状态。"""

    query: str
    marketplace: dict[str, str]
    category: dict[str, Any]
    mock_erp: dict[str, Any]
    keywords: list[dict[str, Any]]
    draft: dict[str, Any]
    validation: dict[str, Any]
    report: dict[str, Any]
    retries: int


def build_listing_graph(body: CommerceRequest):
    """构建 Listing LangGraph（校验失败回炉重写一次）。"""

    marketplace = get_marketplace(body.marketplace)
    marketplace_meta = {
        "key": marketplace.code,
        "label": marketplace.label,
        "currency": getattr(marketplace, "currency", ""),
        "locale": getattr(marketplace, "locale", ""),
    }

    async def intent_node(state: ListingState) -> dict[str, Any]:
        return {"category": resolve_category(state["query"])}

    async def collect_node(state: ListingState) -> dict[str, Any]:
        facts = [
            {
                "id": "brief",
                "label": "用户商品 Brief",
                "value": state["query"],
                "source": "user",
                "confidence": 100,
                "requiresConfirmation": False,
            }
        ]
        category = state.get("category") or {}
        mock_erp = {
            "sourceName": "Mock ERP Adapter",
            "sku": "DEMO-SKU-PENDING",
            "brand": "待确认品牌",
            "productName": category.get("categoryName"),
            "productType": category.get("categoryNameEn"),
            "facts": facts,
            "assumptions": ["SKU、品牌、材质、尺寸、认证和性能参数均需人工补充。"],
            "readyForPublish": False,
        }
        return {"mock_erp": mock_erp}

    async def keywords_node(state: ListingState) -> dict[str, Any]:
        return {"keywords": _keywords(state["query"], state.get("category") or {})}

    async def draft_node(state: ListingState) -> dict[str, Any]:
        keywords = state.get("keywords") or []
        return {"draft": _draft(state["query"], keywords)}

    async def validate_node(state: ListingState) -> dict[str, Any]:
        keywords = state.get("keywords") or []
        return {"validation": _validate(state.get("draft") or {}, keywords)}

    def after_validate(state: ListingState) -> str:
        validation = state.get("validation") or {}
        issues = validation.get("issues") or []
        has_error = any(item.get("severity") == "error" for item in issues)
        if has_error and int(state.get("retries") or 0) < 1:
            return "draft"
        return "report"

    async def report_node(state: ListingState) -> dict[str, Any]:
        category = state.get("category") or {}
        report = {
            "version": 1,
            "mode": "listing-demo",
            "generatedAt": datetime.now(UTC).isoformat(),
            "query": body.query,
            "marketplace": body.marketplace,
            "marketplaceLabel": marketplace_meta["label"],
            "locale": marketplace_meta["locale"],
            "category": category,
            "mockErp": state.get("mock_erp"),
            "keywords": state.get("keywords") or [],
            "draft": state.get("draft"),
            "validation": state.get("validation"),
            "competitors": [],
            "source": {
                "provider": "demo-market",
                "sampleSize": 0,
                "isDemo": True,
                "description": "离线 Listing Demo；未连接 Seller Central 或真实 ERP。",
                "warnings": ["此结果不可直接发布，所有商品事实必须人工复核。"],
            },
            "warnings": ["Listing 模式当前为安全演示流程，不会写入任何电商平台。"],
        }
        return {"report": report}

    graph = StateGraph(ListingState)
    graph.add_node("intent", intent_node)
    graph.add_node("collect", collect_node)
    graph.add_node("keywords", keywords_node)
    graph.add_node("draft", draft_node)
    graph.add_node("validate", validate_node)
    graph.add_node("report", report_node)
    graph.add_edge(START, "intent")
    graph.add_edge("intent", "collect")
    graph.add_edge("collect", "keywords")
    graph.add_edge("keywords", "draft")
    graph.add_edge("draft", "validate")
    graph.add_conditional_edges("validate", after_validate, {"draft": "draft", "report": "report"})
    graph.add_edge("report", END)
    return graph.compile()


__all__ = ["ResearchState", "ListingState", "build_research_graph", "build_listing_graph"]
