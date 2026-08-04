"""把普通问答服务接入统一 Agent Runtime。"""

from __future__ import annotations

from collections.abc import AsyncIterator

from backend.models.router import ModelSelection
from backend.runtime.contracts import RuntimeContext, RuntimeRequest
from backend.schemas.chat import ChatRequest
from backend.services.llm.credentials import LlmCredentials
from backend.services.qa import stream_qa_agent


class QAAgentAdapter:
    """复用现有模型网关，同时接收统一 Context、Memory 和 Skill。"""

    agent_id = "qa"

    async def stream(
        self,
        *,
        request: RuntimeRequest,
        context: RuntimeContext,
        model: ModelSelection,
    ) -> AsyncIterator[str]:
        """校验请求与凭证类型，再执行 QA 流式服务。"""

        if not isinstance(request.payload, ChatRequest):
            raise TypeError("QA Agent 只接受 ChatRequest 请求对象")
        if not isinstance(request.credentials, LlmCredentials):
            raise TypeError("QA Agent 缺少有效的 LLM 凭证对象")

        async for frame in stream_qa_agent(
            body=request.payload,
            preferred_model_id=model.model_id,
            credentials=request.credentials,
            runtime_context=context.rendered,
        ):
            yield frame
