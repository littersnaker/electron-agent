"""跨境市场研究业务编排。"""

from __future__ import annotations

import random
from datetime import UTC, datetime
from typing import Any, AsyncIterator

from backend.schemas.commerce import CommerceRequest
from backend.services.commerce.analytics import (
    build_insights,
    calculate_metrics,
    observations_to_products,
    resolve_category,
)
from backend.services.commerce.marketplaces import get_marketplace
from backend.services.commerce.talordata import request_search
from backend.utils.sse import sse_packet


def _progress(stage: str, progress: int, detail: str) -> str:
    """生成与现有 React Hook 兼容的 Commerce 进度事件。"""

    return sse_packet("COMMERCE_PROGRESS", {"stage": stage, "progress": progress, "detail": detail})


def _demo_observations(query: str, currency: str, count: int = 12) -> list[dict[str, Any]]:
    """在真实来源不可用时生成明确标记的稳定演示样本。

    演示数据只用于保证产品流程可体验，报告中会始终显示 ``isDemo`` 和警告，
    不会伪装成真实市场事实。
    """

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


async def stream_research(
    body: CommerceRequest, credentials: dict[str, str]
) -> AsyncIterator[str]:
    """执行市场研究并以 SSE 持续发送进度、报告和用量信息。"""

    marketplace = get_marketplace(body.marketplace)
    yield _progress("intent", 8, "正在识别目标市场、品类范围和研究目标…")
    category = resolve_category(body.query)
    yield _progress("category", 20, "已生成公开搜索关键词和分析维度。")

    observations: list[dict[str, Any]] = []
    warnings: list[str] = []
    diagnostic: dict[str, Any] = {}
    token = credentials.get("talordata")
    yield _progress("collect", 38, "正在采集公开市场搜索与 Shopping 信号…")
    if token:
        query_plan = category["keywords"][:2] or [body.query]
        for keyword in query_plan:
            for engine in ("google", "google_shopping"):
                try:
                    items, current_diagnostic = await request_search(
                        token,
                        keyword,
                        marketplace,
                        engine,
                        max(4, min(body.sample_size // 2, 12)),
                    )
                    diagnostic = current_diagnostic
                    observations.extend(items)
                except RuntimeError as exc:
                    warnings.append(str(exc))
        unique = {item["id"]: item for item in observations}
        observations = list(unique.values())[: body.sample_size]

    is_demo = not observations
    if is_demo:
        warnings.append("真实公开数据源未配置、不可用或没有返回可解析结果，本轮使用明确标记的演示数据。")
        observations = _demo_observations(body.query, marketplace.currency, min(body.sample_size, 16))

    yield _progress("normalize", 58, "正在去重并统一标题、价格、评分和来源字段…")
    products = observations_to_products(observations)
    metrics = calculate_metrics(observations, products, marketplace.currency)
    yield _progress("analyze", 76, "正在计算市场活跃度、竞争开放度和价格信号…")
    insights = build_insights(metrics, is_demo)
    yield _progress("strategy", 91, "正在整理机会、风险和下一步验证动作…")

    source_status = "demo" if is_demo else "collected"
    provider = "demo-market" if is_demo else "talordata-market"
    report = {
        "version": 3,
        "runMode": "demo" if is_demo else "market-intelligence",
        "generatedAt": datetime.now(UTC).isoformat(),
        "query": body.query,
        "marketplace": body.marketplace,
        "marketplaceLabel": marketplace.label,
        "category": category,
        "products": products,
        "observations": observations,
        "metrics": metrics,
        "insights": insights,
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
                "warnings": warnings,
                "metrics": {"observationCount": len(observations)},
            },
            *[
                {
                    "id": source_id,
                    "label": label,
                    "status": "unconfigured",
                    "quality": "unavailable",
                    "sampleSize": 0,
                    "coverage": [],
                    "summary": "当前 Python 迁移版未启用该可选增强来源。",
                    "warnings": [],
                }
                for source_id, label in (("amazon", "Amazon"), ("keepa", "Keepa"), ("tiktok-shop", "TikTok Shop"), ("temu", "Temu"), ("1688", "1688"))
            ],
        ],
        "confidenceScore": 28 if is_demo else min(85, 45 + len(observations) * 2),
        "warnings": warnings,
        "diagnostic": diagnostic,
    }
    yield sse_packet("COMMERCE_REPORT", report)
    yield sse_packet("USAGE", {"promptTokens": 0, "completionTokens": 0, "totalTokens": 0})
    yield _progress("done", 100, "市场研究已完成。")
