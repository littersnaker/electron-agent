"""跨境市场研究业务编排（LangGraph 驱动）。"""

from __future__ import annotations

from typing import AsyncIterator

from backend.schemas.commerce import CommerceRequest
from backend.services.commerce.langgraph import build_research_graph
from backend.utils.sse import sse_packet


def _progress(stage: str, progress: int, detail: str) -> str:
    """生成与现有 React Hook 兼容的 Commerce 进度事件。"""

    return sse_packet(
        "COMMERCE_PROGRESS",
        {"stage": stage, "progress": progress, "detail": detail},
    )


async def stream_research(
    body: CommerceRequest, credentials: dict[str, str]
) -> AsyncIterator[str]:
    """通过 LangGraph 执行市场研究，并以 SSE 持续发送进度、报告和用量信息。"""

    graph = build_research_graph(body, credentials)
    initial: dict[str, object] = {
        "query": body.query,
        "marketplace": {},
        "sample_size": body.sample_size,
        "credentials": credentials,
        "category": {},
        "observations": [],
        "warnings": [],
        "diagnostic": {},
        "products": [],
        "metrics": {},
        "insights": {},
        "report": {},
        "is_demo": False,
        "platform_status": [],
    }
    emitted_collect = False
    async for step in graph.astream(initial, stream_mode="updates"):
        for node, update in step.items():
            if node == "intent":
                yield _progress("intent", 8, "正在识别目标市场、品类范围和研究目标…")
                yield _progress("category", 20, "已生成公开搜索关键词和分析维度。")
            elif node in {"search_source", "demo_fill"}:
                if not emitted_collect:
                    yield _progress("collect", 38, "正在采集公开市场搜索与 Shopping 信号…")
                    emitted_collect = True
            elif node == "normalize":
                yield _progress("normalize", 58, "正在去重并统一标题、价格、评分和来源字段…")
            elif node == "analyze":
                yield _progress("analyze", 76, "正在计算市场活跃度、竞争开放度和价格信号…")
            elif node == "report":
                yield _progress("strategy", 91, "正在整理机会、风险和下一步验证动作…")
                yield sse_packet("COMMERCE_REPORT", update["report"])
                yield sse_packet(
                    "USAGE",
                    {"promptTokens": 0, "completionTokens": 0, "totalTokens": 0},
                )
                yield _progress("done", 100, "市场研究已完成。")


__all__ = ["stream_research"]
