"""所有可插拔 Agent 适配器必须遵守的接口。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import Protocol

from backend.services.models.router import ModelSelection
from backend.services.runtime.contracts import RuntimeContext, RuntimeRequest


class BaseAgent(Protocol):
    """定义统一 Runtime 调用 Agent 的最小能力集合。"""

    agent_id: str

    async def stream(
        self,
        *,
        request: RuntimeRequest,
        context: RuntimeContext,
        model: ModelSelection,
    ) -> AsyncIterator[str]:
        """执行一次 Agent 请求，并持续产生业务层流式事件。"""

        ...
