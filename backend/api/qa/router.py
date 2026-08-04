"""QA Agent 的统一 Runtime API 入口。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.runtime.bootstrap import RUNTIME
from backend.runtime.contracts import RuntimeMessage, RuntimeRequest
from backend.schemas.chat import ChatRequest
from backend.services.llm.catalog import AUTO_MODEL_ID
from backend.services.llm.credentials import resolve_credentials
from backend.utils.sse import create_sse_response

router = APIRouter(tags=["qa-agent"])


def _last_user_text(body: ChatRequest) -> str:
    """返回最近一条用户消息，作为 QA Agent 的当前任务文本。"""

    for message in reversed(body.messages):
        if message.role == "user":
            return message.content.strip()
    return ""


@router.post("/api/qa")
async def post_qa(body: ChatRequest, request: Request):
    """通过统一 Runtime 执行普通问答并返回 SSE 流。"""

    preferred_model = request.headers.get("x-llm-model-id", AUTO_MODEL_ID).strip()
    messages = tuple(
        RuntimeMessage(role=message.role, content=message.content)
        for message in body.messages
    )
    runtime_request = RuntimeRequest(
        agent_id="qa",
        payload=body,
        preferred_model_id=preferred_model,
        credentials=resolve_credentials(request),
        session_id=body.session_id,
        project_id=body.project_id,
        user_text=_last_user_text(body),
        messages=messages,
        metadata={"route": "/api/qa"},
    )
    return create_sse_response(RUNTIME.execute_stream(runtime_request))
