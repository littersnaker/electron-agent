"""Code Agent 的统一 Runtime API 入口。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.schemas.chat import ChatRequest
from backend.services.llm.catalog import AUTO_MODEL_ID
from backend.services.llm.credentials import resolve_credentials
from backend.services.runtime.bootstrap import RUNTIME
from backend.services.runtime.contracts import RuntimeMessage, RuntimeRequest
from backend.utils.sse import create_sse_response

router = APIRouter(tags=["code-agent"])


def _last_user_text(body: ChatRequest) -> str:
    """返回最近一条用户消息，供 Runtime 检索 Memory 和判断复杂度。"""

    for message in reversed(body.messages):
        if message.role == "user":
            return message.content.strip()
    return ""


def _jina_api_key(request: Request) -> str:
    """读取前端通过请求头传入的 Jina API Key。"""

    return request.headers.get("x-jina-api-key", "").strip()


@router.post("/api/chat")
async def post_code_chat(body: ChatRequest, request: Request):
    """把前端 Code 请求交给统一 Runtime，并保持原有 SSE 协议。"""

    preferred_model = request.headers.get("x-llm-model-id", AUTO_MODEL_ID).strip()
    messages = tuple(
        RuntimeMessage(role=message.role, content=message.content) for message in body.messages
    )

    # payload 保留完整 Pydantic 对象，适配器可以继续读取 Agent Mode 和 Checkpoint 字段。
    runtime_request = RuntimeRequest(
        agent_id="coding",
        payload=body,
        preferred_model_id=preferred_model,
        credentials=resolve_credentials(request),
        session_id=body.session_id,
        project_id=body.project_id,
        user_text=_last_user_text(body),
        messages=messages,
        metadata={
            "route": "/api/chat",
            "agentMode": body.agent_mode,
            "jina_api_key": _jina_api_key(request),
        },
    )
    return create_sse_response(RUNTIME.execute_stream(runtime_request))
