"""把现有 Code Agent 平滑接入统一 Runtime 的适配器。"""

from __future__ import annotations

from collections.abc import AsyncIterator

from backend.schemas.chat import ChatRequest
from backend.services.agent.loop.service import stream_code_agent
from backend.services.glm46v import (
    enrich_runtime_context_with_glm46v,
    has_image_attachments,
    strip_image_attachments,
)
from backend.services.glm46v.client import GLM46VError
from backend.services.agent.adapters.registry import register_adapter
from backend.services.llm.credentials import LlmCredentials
from backend.services.models.router import ModelSelection
from backend.services.runtime.contracts import RuntimeContext, RuntimeRequest
from backend.utils.sse import encode_sse


@register_adapter("legacy_code_agent")
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
        """图片先由 GLM 理解，再把视觉规格交给用户选择的代码模型。"""

        if not isinstance(request.payload, ChatRequest):
            raise TypeError("Coding Agent 只接受 ChatRequest 请求对象")
        if not isinstance(request.credentials, LlmCredentials):
            raise TypeError("Coding Agent 缺少有效的 LLM 凭证对象")

        body = request.payload
        enriched_context = context
        if has_image_attachments(body):
            yield encode_sse(
                {
                    "type": "TOOL_STATUS",
                    "content": "GLM-4.6V-Flash 正在提取页面与视觉规格…",
                }
            )
            try:
                enriched_context = await enrich_runtime_context_with_glm46v(
                    request=request,
                    context=context,
                    agent_id=self.agent_id,
                    strict=True,
                )
            except GLM46VError as exc:
                yield encode_sse(
                    {
                        "type": "TEXT",
                        "content": f"⚠️ GLM-4.6V-Flash 图片分析失败：{exc}",
                    }
                )
                return

            # 关键修复：避免主代码模型再次接收原始图片并触发“不支持图像输入”。
            body = strip_image_attachments(body)
            yield encode_sse(
                {
                    "type": "TOOL_STATUS",
                    "content": (
                        "GLM-4.6V-Flash 已生成视觉规格，" f"正在交给 {model.model_id} 执行代码任务…"
                    ),
                }
            )

        # 旧服务继续负责 Checkpoint、并行 Work 和 SSE；Runtime 注入 GLM 视觉证据。
        async for frame in stream_code_agent(
            body=body,
            preferred_model_id=model.model_id,
            credentials=request.credentials,
            runtime_context=enriched_context.rendered,
            jina_api_key=str(request.metadata.get("jina_api_key") or ""),
        ):
            yield frame
