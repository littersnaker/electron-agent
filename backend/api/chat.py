"""Code Agent 流式接口。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.schemas.chat import ChatRequest
from backend.services.agent.service import stream_code_agent
from backend.services.llm.catalog import AUTO_MODEL_ID
from backend.services.llm.credentials import resolve_credentials
from backend.utils.sse import create_sse_response

router = APIRouter(tags=["code-agent"])


@router.post("/api/chat")
async def post_code_chat(body: ChatRequest, request: Request):
    """执行本地项目 Code Agent 工作流并返回 SSE。"""

    preferred = request.headers.get("x-llm-model-id", AUTO_MODEL_ID).strip()
    credentials = resolve_credentials(request)
    return create_sse_response(
        stream_code_agent(
            body=body,
            preferred_model_id=preferred,
            credentials=credentials,
        )
    )
