"""Commerce 市场研究与 Listing 的 LangGraph 管线。

保留现有确定性函数与 SSE 契约（COMMERCE_PROGRESS / COMMERCE_REPORT /
COMMERCE_LISTING / USAGE），把流程改为节点化编排：
- 研究：意图识别 → 多源并行采集 → Demo 兜底 → 归一化 → 分析 → 报告
- Listing：意图 → 档案收集 → 关键词 → 初稿 → 校验（失败回炉重写一次）→ 报告
"""

from __future__ import annotations

import asyncio
import operator
import os
import random
from datetime import UTC, datetime
from typing import Annotated, Any, TypedDict

from langgraph.graph import END, START, StateGraph
from langgraph.types import Send

from backend.schemas.commerce import CommerceRequest
from backend.services.commerce.analytics import (
    build_insights,
    calculate_metrics,
    calculate_review_stats,
    deterministic_review_sentiment,
    observations_to_products,
    resolve_category,
)
from backend.services.commerce.drafts import save_listing_draft
from backend.services.commerce.listing import _draft, _keywords, _validate
from backend.services.commerce.llm import (
    CommerceCategoryAnalysis,
    CommerceInsights,
    CommerceListingDraft,
    CommerceReviewInsights,
    LlmConfig,
    try_complete_json,
)
from backend.services.commerce.marketplaces import get_marketplace
from backend.services.commerce.sources.ali1688 import search_1688
from backend.services.commerce.sources.amazon import search_amazon
from backend.services.commerce.sources.amazon_reviews import fetch_amazon_reviews
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


def _demo_reviews(asin: str, title: str, count: int = 8) -> list[dict[str, Any]]:
    """生成明确标注的演示评论，保证无真实评论时报告仍可展示分析结构。"""

    samples = [
        ("实用", 4.0, "做工扎实，日常使用完全够用，物流也快。"),
        ("不错", 4.5, "和描述一致，性价比可以，暂时没发现问题。"),
        ("一般", 3.0, "功能符合预期，但包装略显简陋，细节还有提升空间。"),
        ("值得", 5.0, "用了两周很满意，续航和手感都超出预期。"),
        ("失望", 2.0, "收到货有轻微瑕疵，客服处理偏慢，体验一般。"),
        ("推荐", 4.5, "整体推荐，安装简单，说明书清晰。"),
        ("耐用", 4.0, "用了几个月依旧稳定，没有出现明显磨损。"),
        ("质感", 4.5, "颜值高、做工细腻，送礼也合适。"),
    ]
    reviews: list[dict[str, Any]] = []
    for index in range(count):
        title_text, rating, text = samples[index % len(samples)]
        reviews.append(
            {
                "id": f"demo-review-{asin}-{index + 1}",
                "asin": asin,
                "rating": rating,
                "title": title_text,
                "text": f"{text}（离线演示样本，不代表真实评论。）",
                "author": "Demo Buyer",
                "date": "",
                "verifiedPurchase": index % 3 == 0,
                "isDemo": True,
            }
        )
    return reviews


_CATEGORY_PROMPT = """目标市场：__MARKET__
用户问题：__QUERY__

请输出品类分析 JSON：
{
  "categoryName": "中文类目名",
  "categoryNameEn": "英文类目名",
  "keywords": ["3-6 个核心关键词"],
  "targetAudience": "目标人群一句话",
  "sellingPoints": ["可能的卖点"],
  "complianceRisks": ["合规风险"],
  "assumptions": ["需要用户确认的假设"]
}
只基于问题推断，拿不准的写进 assumptions。"""


_INSIGHTS_PROMPT = """公开样本（仅标题/价格/评分/评论数，不代表真实销量）：
__SAMPLE__

计算指标：
__METRICS__

请输出 JSON：
{
  "summary": "一段总结",
  "opportunities": ["机会点"],
  "risks": ["风险点"],
  "actions": ["下一步可执行动作"]
}
禁止编造样本外数据（销量、搜索量、利润率等）。"""


_LISTING_PROMPT = """用户 Brief：__QUERY__
关键词：__KEYWORDS__
校验反馈（如为空则忽略）：__FEEDBACK__

请输出 Listing JSON：
{
  "title": "标题（≤75 字符，含核心词）",
  "bulletPoints": ["4-5 条卖点，每条约 100-200 字符"],
  "productDescription": "产品描述，基于 Brief 事实",
  "searchTerms": "后台搜索词，≤240 字节"
}
禁止编造尺寸、材质、认证、保修、性能等未提供的事实。"""


_REVIEW_PROMPT = """商品：__TITLE__
市场：__MARKET__

以下是从 Amazon 评论页采集到的用户评论（标题 | 星级 | 正文截断）：
__REVIEWS__

请输出评论洞察 JSON：
{
  "summary": "整体口碑一句话总结",
  "positiveTopics": ["用户反复提到的正面点，3-6 个"],
  "negativeTopics": ["用户反复抱怨的负面点，3-6 个"],
  "keyFindings": ["2-4 条关键发现"],
  "suggestions": ["针对负面点的改进建议，2-4 条"]
}
只基于给定评论，禁止编造样本外的销量、排名等数据。"""


def _compact_products(products: list[dict[str, Any]], limit: int = 20) -> str:
    """把商品样本压缩成 LLM 可读的紧凑文本。"""

    lines: list[str] = []
    for item in products[:limit]:
        title = str(item.get("title") or "?")[:80]
        price = item.get("price")
        rating = item.get("rating")
        reviews = item.get("reviewCount")
        lines.append(
            f"- {title} | price={price} | rating={rating} | reviews={reviews}"
        )
    return "\n".join(lines)


# 评论分析最多覆盖的商品数；只对评论量最高的 Amazon 商品执行。
_REVIEW_MAX_PRODUCTS = 3


def _review_sources(state: ResearchState) -> list[dict[str, Any]]:
    """为报告生成 amazon-reviews 数据源条目（成功/降级/未执行三种状态）。"""

    analyses = state.get("review_analyses") or []
    if not analyses:
        return [
            {
                "id": "amazon-reviews",
                "label": "Amazon 评论",
                "status": "unconfigured",
                "quality": "unavailable",
                "sampleSize": 0,
                "coverage": [],
                "summary": "本轮未采集到 Amazon 商品评论。",
                "warnings": [],
            }
        ]
    collected = [item for item in analyses if not item.get("dataSource", {}).get("isDemo")]
    demo_count = len(analyses) - len(collected)
    sample_size = sum(int(item.get("stats", {}).get("sampleSize") or 0) for item in analyses)
    return [
        {
            "id": "amazon-reviews",
            "label": "Amazon 评论",
            "status": "collected" if collected else "demo",
            "quality": "medium" if collected and not demo_count else "low",
            "sampleSize": sample_size,
            "coverage": ["评分分布", "情感主题", "评论样本"],
            "summary": (
                f"已分析 {len(analyses)} 个商品的 {sample_size} 条评论。"
                if collected
                else "评论采集失败，使用演示样本占位。"
            ),
            "warnings": [
                warning
                for item in analyses
                for warning in (item.get("warnings") or [])
            ][:5],
        }
    ]


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
    insights_source: str
    review_analyses: Annotated[list[dict[str, Any]], operator.add]
    report: dict[str, Any]
    is_demo: bool
    platform_status: Annotated[list[dict[str, Any]], operator.add]


def build_research_graph(
    body: CommerceRequest,
    credentials: dict[str, str],
    llm: LlmConfig | None = None,
):
    """构建市场研究 LangGraph。"""

    marketplace = get_marketplace(body.marketplace)
    marketplace_meta = {
        "key": marketplace.code,
        "label": marketplace.label,
        "currency": marketplace.currency,
        "locale": getattr(marketplace, "locale", ""),
    }

    async def intent_node(state: ResearchState) -> dict[str, Any]:
        if llm is not None:
            analysis = await try_complete_json(
                llm,
                system_prompt=(
                    "你是跨境电商品类分析师。根据用户问题输出结构化品类分析，"
                    "只返回一个 JSON 对象，禁止 Markdown 围栏。"
                ),
                user_prompt=_CATEGORY_PROMPT.replace(
                    "__QUERY__", state["query"]
                ).replace("__MARKET__", marketplace_meta["label"]),
                schema_cls=CommerceCategoryAnalysis,
            )
            if analysis is not None:
                category = analysis.model_dump()
                category["analysisDimensions"] = [
                    "价格带",
                    "公开评分",
                    "评论量",
                    "竞争格局",
                    "商品可见度",
                ]
                category["researchGoal"] = state["query"]
                category["llmEnhanced"] = True
                return {"category": category}
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
        # Amazon 始终作为并行来源：有 SP-API 凭据走官方 API，否则回退公开页爬虫。
        sends.append(
            Send(
                "platform_source",
                {
                    "provider": "amazon",
                    "query": body.query,
                    "limit": max(4, min(body.sample_size // 2, 12)),
                    "credentials": dict(state["credentials"]),
                    "marketplace": marketplace,
                },
            )
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
            if provider == "amazon":
                items, _diagnostic = await search_amazon(
                    query,
                    payload["marketplace"],
                    creds,
                    limit,
                )
            elif provider == "tiktok-shop":
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
        insights_source = "template"
        insights = build_insights(metrics, is_demo)
        if llm is not None and products:
            llm_insights = await try_complete_json(
                llm,
                system_prompt=(
                    "你是跨境电商选品分析师。基于给定的真实公开样本推理机会、风险和行动建议，"
                    "禁止编造样本中不存在的数据（如销量、搜索量、利润率）。"
                    "只返回一个 JSON 对象，禁止 Markdown 围栏。"
                ),
                user_prompt=_INSIGHTS_PROMPT.replace(
                    "__SAMPLE__", _compact_products(products)
                ).replace("__METRICS__", str(metrics)),
                schema_cls=CommerceInsights,
            )
            if llm_insights is not None:
                insights = llm_insights.model_dump()
                insights_source = "llm"
        return {
            "metrics": metrics,
            "insights": insights,
            "insights_source": insights_source,
            "is_demo": is_demo,
        }

    async def _analyze_one_review_product(
        product: dict[str, Any],
        credentials: dict[str, str],
        llm_enhanced: bool,
    ) -> dict[str, Any]:
        """采集并分析单个商品的评论；任何失败降级为演示数据，不中断流程。"""

        asin = str(product.get("asin") or "").strip()
        # 商品 id 形如 "amazon-<ASIN>" 或 TalorData 的 "market-*"；只有 Amazon 源才有 ASIN。
        amazon_asin = (
            asin[len("amazon-") :]
            if asin.startswith("amazon-") and len(asin) > len("amazon-")
            else asin
        )
        title = str(product.get("title") or "")[:160]
        review_limit = int(os.getenv("COMMERCE_REVIEW_LIMIT", "30").strip() or 30)
        warnings: list[str] = []
        is_demo = False
        try:
            reviews, _diagnostic = await fetch_amazon_reviews(
                amazon_asin,
                marketplace,
                dict(credentials),
                limit=review_limit,
            )
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"Amazon 评论采集失败：{str(exc)[:160]}")
            reviews = _demo_reviews(amazon_asin, title)
            is_demo = True
        if not reviews:
            warnings.append("Amazon 评论页未解析到评论，使用演示样本占位。")
            reviews = _demo_reviews(amazon_asin, title)
            is_demo = True
        stats = calculate_review_stats(reviews)
        sentiment = deterministic_review_sentiment(reviews)
        sentiment_source = "template"
        samples = [
            {
                "rating": item.get("rating"),
                "title": item.get("title"),
                "text": item.get("text"),
                "date": item.get("date"),
                "verifiedPurchase": item.get("verifiedPurchase"),
            }
            for item in reviews[:3]
        ]
        # LLM 增强只对第一个商品执行，控制耗时与 token 消耗。
        if llm is not None and llm_enhanced and not is_demo:
            llm_insights = await try_complete_json(
                llm,
                system_prompt=(
                    "你是跨境电商评论分析师。基于给定评论提炼口碑重点与改进建议，"
                    "只返回一个 JSON 对象，禁止 Markdown 围栏。"
                ),
                user_prompt=_REVIEW_PROMPT.replace(
                    "__TITLE__", title
                ).replace("__MARKET__", marketplace_meta["label"]).replace(
                    "__REVIEWS__",
                    "\n".join(
                        f"- {item.get('title', '')} | {item.get('rating', '')}星 | "
                        f"{str(item.get('text', ''))[:120]}"
                        for item in reviews[:20]
                    ),
                ),
                schema_cls=CommerceReviewInsights,
            )
            if llm_insights is not None:
                sentiment = llm_insights.model_dump()
                sentiment_source = "llm"
        return {
            "asin": amazon_asin,
            "productTitle": title,
            "stats": stats,
            "sentiment": sentiment,
            "sentimentSource": sentiment_source,
            "positiveTopics": sentiment.get("positiveTopics") or [],
            "negativeTopics": sentiment.get("negativeTopics") or [],
            "samples": samples,
            "dataSource": {
                "provider": "amazon-reviews",
                "quality": "low" if is_demo else "medium",
                "isDemo": is_demo,
            },
            "warnings": warnings,
        }

    async def review_source(state: ResearchState) -> dict[str, Any]:
        """对 Amazon 商品按评论数取 top 3，并行采集并分析评论。"""

        products = state.get("products") or []
        amazon_products = [
            item
            for item in products
            if str(item.get("asin") or "").startswith("amazon-")
            or str(item.get("source") or "").startswith("amazon")
        ]
        amazon_products.sort(
            key=lambda item: float(item.get("reviewCount") or 0),
            reverse=True,
        )
        selected = amazon_products[: _REVIEW_MAX_PRODUCTS]
        if not selected:
            return {}
        analyses = await asyncio.gather(
            *(
                _analyze_one_review_product(product, state["credentials"], index == 0)
                for index, product in enumerate(selected)
            )
        )
        return {"review_analyses": list(analyses)}

    async def report_node(state: ResearchState) -> dict[str, Any]:
        observations = state.get("observations") or []
        is_demo = bool(state.get("is_demo") or not observations)
        source_status = "demo" if is_demo else "collected"
        provider = "demo-market" if is_demo else "talordata-market"
        report = {
            "version": 3,
            "runMode": "demo" if is_demo else "market-intelligence",
            "llmEnhanced": state.get("insights_source") == "llm"
            or bool((state.get("category") or {}).get("llmEnhanced")),
            "generatedAt": datetime.now(UTC).isoformat(),
            "query": body.query,
            "marketplace": body.marketplace,
            "marketplaceLabel": marketplace_meta["label"],
            "category": state.get("category"),
            "products": state.get("products") or [],
            "observations": observations,
            "metrics": state.get("metrics"),
            "insights": state.get("insights"),
            "reviewAnalyses": state.get("review_analyses") or [],
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
                *_review_sources(state),
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
    graph.add_node("review_source", review_source)
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
    graph.add_edge("analyze", "review_source")
    graph.add_edge("review_source", "report")
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
    draft_source: str
    draft_feedback: str
    draft_id: str
    validation: dict[str, Any]
    report: dict[str, Any]
    retries: int


def build_listing_graph(
    body: CommerceRequest,
    llm: LlmConfig | None = None,
):
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
        feedback = state.get("draft_feedback") or ""
        if llm is not None:
            draft = await try_complete_json(
                llm,
                system_prompt=(
                    "你是亚马逊 Listing 文案专家。基于用户 Brief 和关键词生成合规、"
                    "可读、事实安全的 Listing 草稿。禁止编造尺寸、材质、认证、保修、"
                    "性能等用户未提供的事实。只返回一个 JSON 对象，禁止 Markdown 围栏。"
                ),
                user_prompt=_LISTING_PROMPT.replace(
                    "__QUERY__", state["query"]
                ).replace("__KEYWORDS__", str([item.get("phrase") for item in keywords]))
                .replace("__FEEDBACK__", feedback),
                schema_cls=CommerceListingDraft,
            )
            if draft is not None:
                return {
                    "draft": draft.model_dump(),
                    "draft_source": "llm",
                    "draft_feedback": "",
                }
        return {"draft": _draft(state["query"], keywords), "draft_source": "template"}

    async def validate_node(state: ListingState) -> dict[str, Any]:
        keywords = state.get("keywords") or []
        return {"validation": _validate(state.get("draft") or {}, keywords)}

    async def retry_node(state: ListingState) -> dict[str, Any]:
        """校验失败后把具体问题回传给 draft 节点，并递增重试计数。"""

        validation = state.get("validation") or {}
        issues = validation.get("issues") or []
        feedback = "\n".join(
            f"- {item.get('field')}: {item.get('message')}"
            for item in issues
            if item.get("severity") == "error"
        )
        return {
            "draft_feedback": feedback,
            "retries": int(state.get("retries") or 0) + 1,
        }

    def after_validate(state: ListingState) -> str:
        validation = state.get("validation") or {}
        issues = validation.get("issues") or []
        has_error = any(item.get("severity") == "error" for item in issues)
        if has_error and int(state.get("retries") or 0) < 1:
            return "retry"
        return "report"

    async def report_node(state: ListingState) -> dict[str, Any]:
        category = state.get("category") or {}
        draft_source = state.get("draft_source") or "template"
        draft_id = ""
        try:
            draft_id = await save_listing_draft(
                session_id=body.session_id,
                query=body.query,
                marketplace=body.marketplace,
                draft=state.get("draft") or {},
                source=draft_source,
            )
        except Exception:
            draft_id = ""
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
            "draftSource": draft_source,
            "draftId": draft_id,
            "requiresHumanConfirmation": True,
            "humanConfirmation": {
                "status": "pending" if draft_id else "not_persisted",
                "checklist": [
                    "核对标题长度与关键词覆盖",
                    "补全并核对尺寸/材质/认证等事实字段",
                    "由运营负责人确认后方可发布",
                ],
            },
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
    graph.add_node("retry", retry_node)
    graph.add_node("report", report_node)
    graph.add_edge(START, "intent")
    graph.add_edge("intent", "collect")
    graph.add_edge("collect", "keywords")
    graph.add_edge("keywords", "draft")
    graph.add_edge("draft", "validate")
    graph.add_edge("retry", "draft")
    graph.add_conditional_edges(
        "validate",
        after_validate,
        {"retry": "retry", "report": "report"},
    )
    graph.add_edge("report", END)
    return graph.compile()


__all__ = ["ResearchState", "ListingState", "build_research_graph", "build_listing_graph"]
