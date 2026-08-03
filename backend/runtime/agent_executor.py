"""统一 Agent 执行器。"""

from __future__ import annotations

from collections.abc import AsyncIterator

from backend.agents.base import BaseAgent
from backend.models.router import ModelSelection
from backend.runtime.contracts import RuntimeContext, RuntimeRequest


class AgentExecutor:
    """隔离 Runtime 编排与具体 Agent 的流式执行细节。"""

    async def stream(
        self,
        *,
        agent: BaseAgent,
        request: RuntimeRequest,
        context: RuntimeContext,
        model: ModelSelection,
    ) -> AsyncIterator[str]:
        """调用 Agent 适配器，并过滤不合法的空事件。"""

        async for event in agent.stream(request=request, context=context, model=model):
            # SSE 调用方要求字符串事件；空字符串没有业务价值，直接丢弃可减少无效网络帧。
            if not isinstance(event, str):
                raise TypeError("Agent 流式事件必须是字符串")
            if event:
                yield event
