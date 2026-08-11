"""把普通问答服务接入统一 Agent Runtime。"""

from __future__ import annotations

from collections.abc import AsyncIterator

from backend.schemas.chat import ChatRequest
from backend.services.glm46v import (
    enrich_runtime_context_with_glm46v,
    has_image_attachments,
    strip_image_attachments,
)
from backend.services.glm46v.client import GLM46VError
from backend.services.llm.credentials import LlmCredentials
from backend.services.models.router import ModelSelection
from backend.services.qa import stream_qa_agent
from backend.services.runtime.contracts import RuntimeContext, RuntimeRequest
from backend.utils.sse import encode_sse


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
        """图片先由 GLM 理解，再把纯文本证据交给用户选择的主模型。"""

        if not isinstance(request.payload, ChatRequest):
            raise TypeError("QA Agent 只接受 ChatRequest 请求对象")
        if not isinstance(request.credentials, LlmCredentials):
            raise TypeError("QA Agent 缺少有效的 LLM 凭证对象")

        body = request.payload
        enriched_context = context
        if has_image_attachments(body):
            yield encode_sse(
                {
                    "type": "TOOL_STATUS",
                    "content": "GLM-4.6V-Flash 正在分析上传图片…",
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

            # 关键修复：GLM 已把图片转成文字证据，不能再把原图片送给 DeepSeek。
            body = strip_image_attachments(body)
            yield encode_sse(
                {
                    "type": "TOOL_STATUS",
                    "content": (
                        "GLM-4.6V-Flash 已完成图片理解，"
                        f"正在交给 {model.model_id} 生成回答…"
                    ),
                }
            )

        async for frame in stream_qa_agent(
            body=body,
            preferred_model_id=model.model_id,
            credentials=request.credentials,
            runtime_context=enriched_context.rendered,
        ):
            yield frame
