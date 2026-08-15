"""QA Agent 的模型调用与 SSE 事件转换。"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from backend.core.config import get_settings
from backend.schemas.chat import ChatRequest
from backend.services.embeddings.jina_client import JinaError
from backend.services.embeddings.retrieval import search_knowledge
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage
from backend.services.qa.attachments import decode_image_attachment
from backend.services.qa.prompt import build_qa_system_prompt
from backend.utils.sse import encode_sse, encode_sse_comment

LOGGER = logging.getLogger(__name__)


def _render_knowledge_block(results: list[dict[str, object]]) -> str:
    """把知识库检索结果渲染成带来源的提示词片段。"""

    sections: list[str] = []
    for item in results:
        source = str(item.get("sourcePath") or item.get("sourceType") or "未知来源")
        score = item.get("score")
        score_text = f"{float(score):.3f}" if isinstance(score, (int, float)) else "?"
        parent_tag = "（父文本）" if item.get("parentUsed") else ""
        text = str(item.get("chunkText") or "")
        sections.append(f"--- SOURCE: {source} [score={score_text}] {parent_tag} ---\n{text}")
    return "\n\n".join(sections)


def _build_messages(
    body: ChatRequest,
    runtime_context: str,
    knowledge_context: str = "",
) -> list[LlmMessage]:
    """把前端消息、图片附件和 Runtime 上下文转换成模型消息。"""

    images = [decode_image_attachment(item) for item in body.attachments]
    messages = [
        LlmMessage(
            "system",
            build_qa_system_prompt(runtime_context, knowledge_context),
        )
    ]
    last_user_index = max(
        (index for index, message in enumerate(body.messages) if message.role == "user"),
        default=-1,
    )

    for index, message in enumerate(body.messages):
        # 图片只挂到最后一条用户消息，避免在多轮历史中重复发送同一批 Base64 数据。
        current_images = images if index == last_user_index and message.role == "user" else []
        messages.append(LlmMessage(message.role, message.content, images=current_images))
    return messages


async def stream_qa_agent(
    *,
    body: ChatRequest,
    preferred_model_id: str,
    credentials: LlmCredentials,
    runtime_context: str = "",
    jina_api_key: str = "",
) -> AsyncIterator[str]:
    """执行 QA 模型调用，并输出与现有 React 前端兼容的 SSE 数据帧。"""

    yield encode_sse_comment()
    knowledge_context, knowledge_sources, knowledge_metrics = await _load_knowledge_context(
        body, jina_api_key
    )
    if knowledge_metrics is not None:
        # 只要执行了知识库检索，就向前端广播来源（空列表表示未命中），
        # 让用户能明确判断回答是否基于知识库内容。
        yield encode_sse(
            {
                "type": "KNOWLEDGE_SOURCES",
                "payload": {
                    "sources": knowledge_sources,
                    "count": len(knowledge_sources),
                    "searched": True,
                    **knowledge_metrics,
                },
            }
        )
    try:
        thinking_open = False
        thinking_closed = False
        async for chunk in GATEWAY.stream(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=_build_messages(body, runtime_context, knowledge_context),
            temperature=0.3,
            audit={"agentRole": "qa_stream"},
        ):
            content = ""

            # 推理文本使用旧前端已经识别的边界标记，保持界面行为不变。
            if chunk.reasoning_delta:
                if not thinking_open:
                    thinking_open = True
                    content += "<INTERNAL_THINK_START>"
                content += chunk.reasoning_delta
            if chunk.text_delta:
                if thinking_open and not thinking_closed:
                    thinking_closed = True
                    content += "<INTERNAL_THINK_END>"
                content += chunk.text_delta
            if content:
                yield encode_sse({"type": "TEXT", "content": content})

            # Token 用量仍沿用旧字段，避免前端统计组件需要同步改造。
            if chunk.usage:
                yield encode_sse(
                    {
                        "type": "USAGE",
                        "content": {
                            "prompt": chunk.usage.prompt,
                            "completion": chunk.usage.completion,
                            "total": chunk.usage.total,
                            "unit": "tokens",
                            "label": "Tokens",
                        },
                    }
                )

        if thinking_open and not thinking_closed:
            yield encode_sse({"type": "TEXT", "content": "<INTERNAL_THINK_END>"})
    except Exception as exc:
        # QA 接口历史行为是在流中显示错误，而不是中途关闭 SSE 连接。
        yield encode_sse({"type": "TEXT", "content": f"⚠️ {exc}"})


async def _load_knowledge_context(
    body: ChatRequest, jina_api_key: str
) -> tuple[str, list[dict[str, object]], dict[str, object] | None]:
    """执行知识库检索并返回（提示词片段, 来源列表, 检索指标）。

    检索指标为 ``None`` 表示本轮没有执行检索（未开启/未配置密钥/用户显式
    关闭）；来源空列表表示执行了检索但没有命中，前端据此区分展示。
    """

    settings = get_settings()
    if not settings.jina_embedding_enabled:
        return "", [], None
    if body.knowledge_search is False:
        return "", [], None
    user_text = ""
    for message in reversed(body.messages):
        if message.role == "user":
            user_text = message.content.strip()
            break
    if not user_text:
        return "", [], None
    try:
        result = await search_knowledge(user_text, api_key=jina_api_key, top_k=settings.jina_top_k)
    except JinaError as exc:
        LOGGER.warning("知识库检索失败，本轮不注入知识：%s", exc)
        return "", [], None
    sources = [
        {
            "sourcePath": str(item.get("sourcePath") or ""),
            "sourceType": str(item.get("sourceType") or ""),
            "position": str(item.get("position") or ""),
            "score": item.get("score"),
            "parentUsed": bool(item.get("parentUsed")),
        }
        for item in result.sources
    ]
    metrics = {
        "recallK": result.recall_k,
        "candidateCount": result.candidate_count,
        "topK": result.top_k,
        "reranked": result.reranked,
        "avgScore": result.avg_score,
    }
    return _render_knowledge_block(result.sources), sources, metrics
