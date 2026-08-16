"""把图片识别流水线接入统一 Agent Runtime。"""

from __future__ import annotations

from collections.abc import AsyncIterator

from backend.schemas.chat import ChatRequest
from backend.services.image.service import stream_image_recognition
from backend.services.llm.credentials import LlmCredentials
from backend.services.models.router import ModelSelection
from backend.services.runtime.contracts import RuntimeContext, RuntimeRequest


class ImageAgentAdapter:
    """按固定流水线执行图片识别，并保持现有 SSE 事件协议不变。"""

    agent_id = "image"

    async def stream(
        self,
        *,
        request: RuntimeRequest,
        context: RuntimeContext,
        model: ModelSelection,
    ) -> AsyncIterator[str]:
        """校验图片请求，并把识别流水线事件转发给 Runtime。"""

        del context, model
        if not isinstance(request.payload, ChatRequest):
            raise TypeError("Image Agent 只接受 ChatRequest 请求对象")

        llm_metadata = request.metadata.get("llm") or {}
        credentials: LlmCredentials | None = None
        if isinstance(llm_metadata, dict):
            value = llm_metadata.get("credentials")
            if isinstance(value, LlmCredentials) and value.values:
                credentials = value

        async for frame in stream_image_recognition(
            body=request.payload,
            credentials=credentials,
            preferred_model_id=request.preferred_model_id,
            session_id=request.session_id,
        ):
            yield frame
