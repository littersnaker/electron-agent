"""QA Agent 旧导入路径兼容层。

新代码请从 ``backend.api.qa`` 导入路由；保留本文件是为了平滑迁移已有扩展。
"""

<<<<<<< HEAD
import base64
import re
from collections.abc import AsyncIterator

from fastapi import APIRouter, Request

from backend.core.timezones import PACIFIC_TIMEZONE, now_in_timezone
from backend.schemas.chat import ChatRequest
from backend.schemas.common import FrontendAttachment
from backend.services.llm.catalog import AUTO_MODEL_ID
from backend.services.llm.credentials import resolve_credentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import ImagePart, LlmMessage
from backend.utils.sse import create_sse_response, encode_sse, encode_sse_comment

router = APIRouter(tags=["qa"])


def _qa_system_prompt() -> str:
    """生成带当前时间的 QA 系统提示词。"""

    now = now_in_timezone(PACIFIC_TIMEZONE)
    return f"""你是一个准确、实用、易理解的高级 AI 助手。
默认使用中文；用户使用其他语言时跟随用户语言。先给结论，再给解释和可执行建议。
不确定的信息必须明确说明，不要编造数据、来源或实时状态。
技术问题要给可运行代码、修改位置和关键逻辑。
当前服务器时间：{now.isoformat()}（{PACIFIC_TIMEZONE}）。"""


def _decode_attachment(attachment: FrontendAttachment) -> ImagePart:
    """把前端附件转换成统一图片内容，并校验 Base64。"""

    mime_type = attachment.mime_type.strip()
    data = (attachment.data or "").strip()
    if attachment.data_url:
        match = re.match(
            r"^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$",
            attachment.data_url.strip(),
            re.IGNORECASE,
        )
        if match:
            mime_type, data = match.group(1), match.group(2)
    data = re.sub(r"\s+", "", data)
    if not mime_type.startswith("image/"):
        raise ValueError(f"附件 {attachment.name} 不是图片")
    if not data:
        raise ValueError(f"附件 {attachment.name} 缺少图片数据")
    try:
        base64.b64decode(data, validate=True)
    except ValueError as exc:
        raise ValueError(f"附件 {attachment.name} 的 Base64 数据无效") from exc
    return ImagePart(mime_type, data, attachment.name)


def _build_messages(body: ChatRequest) -> list[LlmMessage]:
    """把前端消息和最后一轮图片附件转换成 LLM 消息。"""

    images = [_decode_attachment(item) for item in body.attachments]
    result = [LlmMessage("system", _qa_system_prompt())]
    last_user_index = max(
        (index for index, message in enumerate(body.messages) if message.role == "user"),
        default=-1,
    )
    for index, message in enumerate(body.messages):
        result.append(
            LlmMessage(
                message.role,
                message.content,
                images=images if index == last_user_index and message.role == "user" else [],
            )
        )
    return result


async def _qa_stream(
    *, body: ChatRequest, request: Request, preferred_model_id: str
) -> AsyncIterator[str]:
    """执行 QA 模型调用并输出前端兼容的 SSE。"""

    yield encode_sse_comment()
    try:
        credentials = resolve_credentials(request)
        thinking_open = False
        thinking_closed = False
        async for chunk in GATEWAY.stream(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=_build_messages(body),
            temperature=0.3,
        ):
            content = ""
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
        yield encode_sse({"type": "TEXT", "content": f"⚠️ {exc}"})


@router.post("/api/qa")
async def post_qa(body: ChatRequest, request: Request):
    """接收普通问答请求并返回 SSE 流。"""

    preferred = request.headers.get("x-llm-model-id", AUTO_MODEL_ID).strip()
    return create_sse_response(_qa_stream(body=body, request=request, preferred_model_id=preferred))
=======
from backend.api.qa import router

__all__ = ["router"]
>>>>>>> changePython
