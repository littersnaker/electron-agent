"""把现有 Code Agent 平滑接入统一 Runtime 的适配器。"""

from __future__ import annotations

from collections.abc import AsyncIterator

from backend.models.router import ModelSelection
from backend.runtime.contracts import RuntimeContext, RuntimeRequest
from backend.schemas.chat import ChatRequest
from backend.services.agent.service import stream_code_agent
from backend.services.llm.credentials import LlmCredentials


class CodeAgentAdapter:
    """复用旧 Code Agent 工作流，同时接受 Runtime 提供的统一上下文。"""

    agent_id = "coding"

    async def stream(
        self,
        *,
        request: RuntimeRequest,
        context: RuntimeContext,
        model: ModelSelection,
    ) -> AsyncIterator[str]:
        """校验旧请求类型，并把 Runtime 选择结果传给原有流式服务。"""

        # 适配层必须先检查 payload，避免错误 Agent 配置把不兼容对象传入旧服务。
        if not isinstance(request.payload, ChatRequest):
            raise TypeError("Coding Agent 只接受 ChatRequest 请求对象")
        if not isinstance(request.credentials, LlmCredentials):
            raise TypeError("Coding Agent 缺少有效的 LLM 凭证对象")

        # 旧服务继续负责精确 Checkpoint、并行 Work 和 SSE 协议；统一 Runtime 负责外围能力。
        async for frame in stream_code_agent(
            body=request.payload,
            preferred_model_id=model.model_id,
            credentials=request.credentials,
            runtime_context=context.rendered,
        ):
            yield frame
