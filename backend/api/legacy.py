"""为旧版调用方保留的兼容接口。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.api.qa import post_qa
from backend.schemas.chat import ChatRequest

router = APIRouter(tags=["legacy"])


@router.post("/api/agent")
async def legacy_agent(body: ChatRequest, request: Request):
    """把旧 ``/api/agent`` 请求转发给新的普通 QA 流。"""

    return await post_qa(body, request)


@router.post("/api/geminiChat")
async def legacy_gemini_chat(body: ChatRequest, request: Request):
    """把旧 Gemini 专用入口转发给统一 LLM Gateway。"""

    return await post_qa(body, request)


@router.get("/api/sentry-example-api")
async def sentry_example_removed() -> dict[str, object]:
    """说明迁移版已经移除 Next/Sentry 示例接口。"""

    return {"ok": True, "message": "FastAPI 迁移版未启用 Sentry 示例接口。"}
