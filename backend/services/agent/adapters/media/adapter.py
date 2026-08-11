"""Media Agent 适配器：接入统一 Runtime，支持单次生成与漫剧管线。"""

from __future__ import annotations

from collections.abc import AsyncIterator

from backend.models.router import ModelSelection
from backend.runtime.contracts import RuntimeContext, RuntimeRequest
from backend.schemas.chat import ChatRequest
from backend.services.llm.credentials import LlmCredentials
from backend.services.media.agent_service import stream_media_agent


class MediaAgentAdapter:
    """把媒体请求转发给 Media Agent 流式服务。"""

    agent_id = "media"

    async def stream(
        self,
        *,
        request: RuntimeRequest,
        context: RuntimeContext,
        model: ModelSelection,
    ) -> AsyncIterator[str]:
        """校验请求与凭据后执行媒体流式服务。"""

        if not isinstance(request.payload, ChatRequest):
            raise TypeError("Media Agent 只接受 ChatRequest 请求对象")
        if not isinstance(request.credentials, LlmCredentials):
            raise TypeError("Media Agent 缺少有效的 LLM 凭据对象")

        async for frame in stream_media_agent(
            body=request.payload,
            credentials=request.credentials,
            preferred_model_id=model.model_id,
        ):
            yield frame


__all__ = ["MediaAgentAdapter"]
