"""Amazon Listing Demo 业务编排。"""

from __future__ import annotations

import re
from datetime import UTC, datetime
from typing import Any, AsyncIterator

from backend.schemas.commerce import CommerceRequest
from backend.services.commerce.analytics import resolve_category
from backend.services.commerce.marketplaces import get_marketplace
from backend.utils.sse import sse_packet


def _progress(stage: str, progress: int, detail: str) -> str:
    """生成 Listing 工作流进度事件。"""

    return sse_packet("COMMERCE_PROGRESS", {"stage": stage, "progress": progress, "detail": detail})


def _keywords(query: str, category: dict[str, Any]) -> list[dict[str, Any]]:
    """从用户 Brief 和类目计划生成去重关键词列表。"""

    phrases = list(category["keywords"])
    phrases.extend(re.findall(r"[A-Za-z][A-Za-z0-9-]{2,}", query.lower()))
    unique = list(dict.fromkeys(phrase.strip() for phrase in phrases if phrase.strip()))[:18]
    return [
        {
            "phrase": phrase,
            "normalized": phrase.lower(),
            "cluster": "core" if index < 3 else "feature",
            "source": "query",
            "score": max(30, 100 - index * 4),
            "placement": "title" if index < 2 else "bullet" if index < 10 else "backend",
        }
        for index, phrase in enumerate(unique)
    ]


def _draft(query: str, keywords: list[dict[str, Any]]) -> dict[str, Any]:
    """生成安全的 Listing 初稿，并避免虚构认证、材质和性能数据。"""

    core = [item["phrase"] for item in keywords[:5]]
    title = " | ".join(core[:3]) or query[:70]
    title = title[:75]
    bullets = [
        "核心用途：根据当前商品 Brief 整理，请发布前核对实际产品功能。",
        "使用场景：围绕目标消费者的日常使用需求组织信息。",
        "清晰表达：保留可验证事实，未提供的尺寸、材质和认证不擅自补充。",
        "关键词布局：核心词自然进入标题和五点描述，避免机械堆砌。",
        "发布提醒：正式上架前请由运营、法务和产品负责人共同确认。",
    ]
    description = (
        f"本 Listing 初稿基于以下 Brief 生成：{query.strip()}\n\n"
        "当前版本是演示稿，仅使用用户已提供信息和通用表达。"
        "任何尺寸、材料、适配范围、认证、保修和性能承诺都需要在发布前补充真实证据。"
    )
    search_terms = " ".join(core[3:] + [item["phrase"] for item in keywords[5:12]])[:240]
    return {
        "title": title,
        "bulletPoints": bullets,
        "productDescription": description,
        "searchTerms": search_terms,
    }


def _validate(draft: dict[str, Any], keywords: list[dict[str, Any]]) -> dict[str, Any]:
    """检查字段长度、关键词覆盖和事实安全提示。"""

    issues: list[dict[str, Any]] = []
    if len(draft["title"]) > 75:
        issues.append({"field": "title", "severity": "error", "code": "TITLE_TOO_LONG", "message": "标题超过 75 个字符。"})
    if len(draft["bulletPoints"]) < 3:
        issues.append({"field": "bulletPoints", "severity": "warning", "code": "TOO_FEW_BULLETS", "message": "建议至少提供 3 条五点描述。"})
    issues.append({
        "field": "facts",
        "severity": "warning",
        "code": "FACT_CONFIRMATION_REQUIRED",
        "message": "模拟 ERP 字段和商品事实必须由人工确认后才能发布。",
    })
    full_text = " ".join([draft["title"], *draft["bulletPoints"], draft["searchTerms"]]).lower()
    covered = [item["phrase"] for item in keywords if item["normalized"] in full_text]
    missing = [item["phrase"] for item in keywords if item["normalized"] not in full_text]
    keyword_score = round(len(covered) / max(len(keywords), 1) * 100)
    return {
        "policyVersion": "amazon-demo-2026-07-27",
        "titleMaxCharacters": 75,
        "bulletMinimumCount": 3,
        "bulletMaximumCount": 5,
        "bulletMinimumCharacters": 10,
        "bulletMaximumCharacters": 255,
        "backendSearchTermMaximumBytes": 240,
        "issues": issues,
        "score": {
            "overall": round((85 + keyword_score + 80 + 88 + 100) / 5),
            "compliance": 85,
            "keywordCoverage": keyword_score,
            "completeness": 80,
            "readability": 88,
            "factualSafety": 100,
        },
        "keywordCoverage": {"covered": covered, "missing": missing},
    }


async def stream_listing(body: CommerceRequest) -> AsyncIterator[str]:
    """通过 LangGraph 生成 Listing Demo，并输出现有界面所需 SSE 事件。"""

    from backend.services.commerce.langgraph import build_listing_graph

    graph = build_listing_graph(body)
    initial: dict[str, object] = {
        "query": body.query,
        "marketplace": {},
        "category": {},
        "mock_erp": {},
        "keywords": [],
        "draft": {},
        "validation": {},
        "report": {},
        "retries": 0,
    }
    async for step in graph.astream(initial, stream_mode="updates"):
        for node, update in step.items():
            if node == "intent":
                yield _progress("intent", 8, "正在理解商品 Brief、目标站点和事实边界…")
                yield _progress("category", 22, "已识别类目词和站点语言。")
            elif node == "collect":
                yield _progress("collect", 35, "当前迁移版使用离线 Demo，不调用 Seller Central 写入接口。")
                yield _progress("erp", 50, "已构建模拟 ERP 档案，并标记所有待确认事实。")
            elif node == "keywords":
                yield _progress("keywords", 66, "已完成核心词、属性词和后台搜索词分配。")
            elif node == "draft":
                yield _progress("draft", 82, "已生成标题、五点描述、产品描述和后台搜索词。")
            elif node == "validate":
                yield _progress("validate", 94, "已检查字段长度、关键词覆盖和事实安全。")
            elif node == "report":
                yield sse_packet("COMMERCE_LISTING", update["report"])
                yield sse_packet(
                    "USAGE",
                    {"promptTokens": 0, "completionTokens": 0, "totalTokens": 0},
                )
                yield _progress("done", 100, "Listing Demo 已完成。")