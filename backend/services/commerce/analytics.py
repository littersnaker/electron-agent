"""跨境市场数据的确定性计算函数。"""

from __future__ import annotations

import re
import statistics
from collections import Counter
from typing import Any


def _bounded(value: float) -> int:
    """把评分限制在 0 到 100，并四舍五入成整数。"""

    return max(0, min(100, round(value)))


def _median(values: list[float]) -> float | None:
    """计算非空数字列表中位数；空列表返回 ``None``。"""

    return round(statistics.median(values), 2) if values else None


def resolve_category(query: str) -> dict[str, Any]:
    """从用户自然语言中生成轻量级类目和关键词计划。

    这是无模型依赖的保底实现，确保没有配置 LLM Key 时电商工作流仍能演示和运行。
    """

    cleaned = re.sub(r"\s+", " ", query).strip()
    words = re.findall(r"[\w\u4e00-\u9fff-]+", cleaned.lower())
    stop_words = {"帮我", "分析", "市场", "amazon", "亚马逊", "listing", "的", "一个", "一下"}
    keywords = [word for word in words if word not in stop_words and len(word) > 1]
    keywords = list(dict.fromkeys(keywords))[:5] or [cleaned[:40] or "product"]
    category_name = " ".join(keywords[:3])
    return {
        "categoryName": category_name,
        "categoryNameEn": category_name,
        "keywords": keywords,
        "subcategories": [],
        "analysisDimensions": ["价格带", "公开评分", "评论量", "竞争域名", "商品可见度"],
        "researchGoal": cleaned,
    }


def observations_to_products(observations: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """把具备购物属性的公开结果转换成商品卡片数据。"""

    products: list[dict[str, Any]] = []
    for item in observations:
        if item.get("resultType") != "shopping" and item.get("price") is None:
            continue
        products.append(
            {
                "asin": item["id"],
                "title": item["title"],
                "platform": "market-search",
                "brand": item.get("merchant"),
                "productUrl": item.get("url"),
                "price": item.get("price"),
                "currency": item.get("currency"),
                "rating": item.get("rating"),
                "reviewCount": item.get("reviewCount"),
                "source": item.get("provider", "talordata-market"),
                "isDemo": item.get("isDemo", False),
            }
        )
    return products[:24]


def calculate_metrics(
    observations: list[dict[str, Any]], products: list[dict[str, Any]], currency: str
) -> dict[str, Any]:
    """根据公开样本计算报告指标，不伪造真实销量或搜索量。"""

    prices = [float(item["price"]) for item in observations if isinstance(item.get("price"), (int, float))]
    reviews = [float(item["reviewCount"]) for item in observations if isinstance(item.get("reviewCount"), (int, float))]
    ratings = [float(item["rating"]) for item in observations if isinstance(item.get("rating"), (int, float))]
    domains = [str(item["domain"]) for item in observations if item.get("domain")]
    domain_counts = Counter(domains)
    top_domain_share = max(domain_counts.values(), default=0) / max(len(domains), 1)
    sample_size = len(observations)
    price_coverage = len(prices) / max(sample_size, 1)
    review_coverage = len(reviews) / max(sample_size, 1)
    diversity = len(domain_counts) / max(len(domains), 1)
    demand_score = _bounded(25 + min(sample_size, 30) * 1.8 + review_coverage * 20)
    competition_score = _bounded(25 + diversity * 55 - top_domain_share * 20)
    price_health = _bounded(20 + price_coverage * 75)
    new_entry = _bounded(competition_score * 0.55 + price_health * 0.25 + demand_score * 0.2)
    opportunity = _bounded((demand_score + competition_score + price_health + new_entry) / 4)
    return {
        "sampleSize": len(products),
        "opportunityScore": opportunity,
        "demandScore": demand_score,
        "competitionScore": competition_score,
        "priceHealthScore": price_health,
        "newEntryScore": new_entry,
        "medianPrice": _median(prices),
        "currency": currency,
        "medianReviewCount": _median(reviews),
        "observationCount": sample_size,
        "shoppingResultCount": sum(item.get("resultType") == "shopping" for item in observations),
        "uniqueDomainCount": len(domain_counts),
        "topDomainShare": round(top_domain_share, 3) if domains else None,
        "priceSignalCount": len(prices),
        "medianRating": _median(ratings),
        "platformComparisons": [],
    }


def build_insights(metrics: dict[str, Any], is_demo: bool) -> dict[str, Any]:
    """根据计算指标生成可解释的机会、风险和行动建议。"""

    prefix = "模拟数据仅用于流程演示。" if is_demo else "结论来自本轮公开搜索样本。"
    opportunities = []
    risks = []
    if metrics["competitionScore"] >= 60:
        opportunities.append("公开结果来源较分散，可以进一步寻找差异化细分定位。")
    else:
        risks.append("头部域名或商品集中度较高，新进入者需要更清晰的差异化证据。")
    if metrics["priceHealthScore"] >= 60:
        opportunities.append("价格样本覆盖较好，可以继续拆分主流价格带和价值卖点。")
    else:
        risks.append("可解析价格样本不足，不适合仅凭本报告做备货或定价决策。")
    return {
        "summary": f"{prefix} 综合市场信号分为 {metrics['opportunityScore']}/100。",
        "opportunities": opportunities or ["当前样本可作为下一轮关键词和竞品验证的起点。"],
        "risks": risks or ["公开搜索信号不等同于平台真实销量、利润或转化率。"],
        "actions": [
            "补充目标消费者、成本和差异化功能，再进行第二轮长尾关键词研究。",
            "对排名靠前的商品逐个核验评论内容、合规要求和真实供应链成本。",
            "在正式备货前接入平台授权数据或第三方销售估算工具进行交叉验证。",
        ],
    }


def calculate_review_stats(reviews: list[dict[str, Any]]) -> dict[str, Any]:
    """根据采集到的评论文本计算评分分布与基础比率。"""

    ratings = [
        float(item["rating"])
        for item in reviews
        if isinstance(item.get("rating"), (int, float))
    ]
    distribution = {str(star): 0 for star in range(1, 6)}
    for rating in ratings:
        star = max(1, min(5, round(rating)))
        distribution[str(star)] += 1
    sample_size = len(reviews)
    verified = sum(1 for item in reviews if item.get("verifiedPurchase"))
    positive = sum(1 for rating in ratings if rating >= 4)
    return {
        "sampleSize": sample_size,
        "averageRating": _median(ratings),
        "ratingDistribution": distribution,
        "verifiedPurchaseRatio": round(verified / sample_size, 3) if sample_size else None,
        "positiveRatio": round(positive / len(ratings), 3) if ratings else None,
    }


_POSITIVE_TOPIC_TERMS = (
    "好用",
    "质量",
    "性价比",
    "耐用",
    "颜值",
    "做工",
    "方便",
    "推荐",
    "满意",
    "喜欢",
    "手感",
    "清晰",
    "快速",
    "稳定",
    "完美",
    "不错",
    "好用",
    "值",
    "强",
    "满意",
)
_NEGATIVE_TOPIC_TERMS = (
    "差",
    "垃圾",
    "退货",
    "问题",
    "失望",
    "坏",
    "故障",
    "慢",
    "卡",
    "掉",
    "漏",
    "声音",
    "味道",
    "异味",
    "一般",
    "勉强",
    "后悔",
    "失望",
    "客服",
    "物流",
)


def _topic_hits(reviews: list[dict[str, Any]], terms: tuple[str, ...]) -> list[str]:
    """统计评论正文中出现次数最多的主题词。"""

    counter: Counter[str] = Counter()
    for item in reviews:
        text = f"{item.get('title', '')} {item.get('text', '')}".lower()
        for term in terms:
            if term.lower() in text:
                counter[term] += 1
    return [term for term, _count in counter.most_common(5)]


def deterministic_review_sentiment(
    reviews: list[dict[str, Any]],
) -> dict[str, Any]:
    """无 LLM 的评论情感兜底：按主题词出现频次归纳正负面重点。"""

    positive_topics = _topic_hits(reviews, _POSITIVE_TOPIC_TERMS)
    negative_topics = _topic_hits(reviews, _NEGATIVE_TOPIC_TERMS)
    sample_size = len(reviews)
    if sample_size == 0:
        return {
            "summary": "未采集到可分析的评论内容。",
            "positiveTopics": [],
            "negativeTopics": [],
        }
    summary = (
        f"共分析 {sample_size} 条评论；正面重点"
        f"（{'、'.join(positive_topics) if positive_topics else '暂无显著正面词'}"
        f"），负面重点"
        f"（{'、'.join(negative_topics) if negative_topics else '暂无显著负面词'}）。"
    )
    return {
        "summary": summary,
        "positiveTopics": positive_topics,
        "negativeTopics": negative_topics,
    }
