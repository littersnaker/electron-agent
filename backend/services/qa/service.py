"""QA Agent 的模型调用与 SSE 事件转换。"""

from __future__ import annotations

from collections.abc import AsyncIterator

from backend.schemas.chat import ChatRequest
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage
from backend.services.qa.attachments import decode_image_attachment
from backend.services.qa.prompt import build_qa_system_prompt
from backend.utils.sse import encode_sse, encode_sse_comment


def _build_messages(body: ChatRequest, runtime_context: str) -> list[LlmMessage]:
    """把前端消息、图片附件和 Runtime 上下文转换成模型消息。"""

    images = [decode_image_attachment(item) for item in body.attachments]
    messages = [LlmMessage("system", build_qa_system_prompt(runtime_context))]
    last_user_index = max(
        (index for index, message in enumerate(body.messages) if message.role == "user"),
        default=-1,
    )

    for index, message in enumerate(body.messages):
        # 图片只挂到最后一条用户消息，避免在多轮历史中重复发送同一批 Base64 数据。
        current_images = (
            images if index == last_user_index and message.role == "user" else []
        )
        messages.append(LlmMessage(message.role, message.content, images=current_images))
    return messages


async def stream_qa_agent(
    *,
    body: ChatRequest,
    preferred_model_id: str,
    credentials: LlmCredentials,
    runtime_context: str = "",
) -> AsyncIterator[str]:
    """执行 QA 模型调用，并输出与现有 React 前端兼容的 SSE 数据帧。"""

    yield encode_sse_comment()
    try:
        thinking_open = False
        thinking_closed = False
        async for chunk in GATEWAY.stream(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=_build_messages(body, runtime_context),
            temperature=0.3,
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
