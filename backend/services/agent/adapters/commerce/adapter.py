"""把跨境电商研究与 Listing 工作流接入统一 Agent Runtime。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from typing import cast

from backend.models.router import ModelSelection
from backend.runtime.contracts import RuntimeContext, RuntimeRequest
from backend.schemas.commerce import CommerceRequest
from backend.services.commerce.llm import LlmConfig
from backend.services.commerce.listing import stream_listing
from backend.services.commerce.service import stream_research
from backend.services.llm.credentials import LlmCredentials


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

        llm_metadata = request.metadata.get("llm") or {}
        llm_config = None
        if isinstance(llm_metadata, dict):
            credentials = llm_metadata.get("credentials")
            if isinstance(credentials, LlmCredentials) and credentials.values:
                llm_config = LlmConfig(
                    credentials=credentials,
                    model_id=str(llm_metadata.get("modelId") or "auto"),
                )

        workflow = str(request.metadata.get("workflow") or "research").strip().lower()
        if workflow == "listing":
            async for frame in stream_listing(request.payload, llm=llm_config):
                yield frame
            return

        # 研究工作流需要市场数据源凭证；Runtime 使用 object 保存不同领域凭证。
        if not isinstance(request.credentials, dict):
            raise TypeError("Commerce Agent 缺少有效的数据源凭证对象")
        credentials = cast(dict[str, str], request.credentials)
        async for frame in stream_research(
            request.payload,
            credentials,
            llm=llm_config,
        ):
            yield frame
