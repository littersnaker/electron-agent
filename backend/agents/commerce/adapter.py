"""把跨境电商研究与 Listing 工作流接入统一 Agent Runtime。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import cast

from backend.models.router import ModelSelection
from backend.runtime.contracts import RuntimeContext, RuntimeRequest
from backend.schemas.commerce import CommerceRequest
from backend.services.commerce.listing import stream_listing
from backend.services.commerce.service import stream_research


class CommerceAgentAdapter:
    """根据 Runtime 元数据选择研究或 Listing 子工作流。"""

    agent_id = "commerce"

    async def stream(
        self,
        *,
        request: RuntimeRequest,
        context: RuntimeContext,
        model: ModelSelection,
    ) -> AsyncIterator[str]:
        """校验 Commerce 请求，并保持现有 SSE 事件协议不变。"""

        del context, model
        if not isinstance(request.payload, CommerceRequest):
            raise TypeError("Commerce Agent 只接受 CommerceRequest 请求对象")

        workflow = str(request.metadata.get("workflow") or "research").strip().lower()
        if workflow == "listing":
            async for frame in stream_listing(request.payload):
                yield frame
            return

        # 研究工作流需要市场数据源凭证；Runtime 使用 object 保存不同领域凭证。
        if not isinstance(request.credentials, dict):
            raise TypeError("Commerce Agent 缺少有效的数据源凭证对象")
        credentials = cast(dict[str, str], request.credentials)
        async for frame in stream_research(request.payload, credentials):
            yield frame
