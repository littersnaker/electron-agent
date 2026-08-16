"""图片识别 Agent 的统一 Runtime API 入口与 Excel 下载接口。"""

from __future__ import annotations

import re
import tempfile
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

from backend.schemas.chat import ChatRequest
from backend.services.image.excel import is_safe_excel_filename
from backend.services.llm.catalog import AUTO_MODEL_ID
from backend.services.llm.credentials import resolve_credentials
from backend.services.runtime.bootstrap import RUNTIME
from backend.services.runtime.contracts import RuntimeMessage, RuntimeRequest
from backend.utils.sse import create_sse_response

router = APIRouter(tags=["image-agent"])


def _last_user_text(body: ChatRequest) -> str:
    """返回最近一条用户消息，作为图片识别会话的当前说明文本。"""

    for message in reversed(body.messages):
        if message.role == "user":
            return message.content.strip()
    return ""


@router.post("/api/image/chat")
async def post_image_chat(body: ChatRequest, request: Request):
    """把货架照片识别请求交给统一 Runtime 的 Image Agent 执行。"""

    preferred_model = request.headers.get("x-llm-model-id", AUTO_MODEL_ID).strip()
    messages = tuple(
        RuntimeMessage(role=message.role, content=message.content)
        for message in body.messages
    )
    runtime_request = RuntimeRequest(
        agent_id="image",
        payload=body,
        preferred_model_id=preferred_model,
        credentials=resolve_credentials(request),
        session_id=body.session_id,
        project_id=body.project_id,
        user_text=_last_user_text(body),
        messages=messages,
        metadata={
            "route": "/api/image/chat",
            "llm": {
                "modelId": preferred_model,
                "credentials": resolve_credentials(request),
            },
        },
    )
    return create_sse_response(RUNTIME.execute_stream(runtime_request))


@router.get("/api/image/asset/{session_id}/{name}")
async def get_image_asset(session_id: str, name: str) -> FileResponse:
    """提供图片识别会话生成的 Excel 文件下载。"""

    if not re.match(r"^[A-Za-z0-9_-]{1,80}$", session_id):
        raise HTTPException(status_code=400, detail="非法的会话 ID")
    if not is_safe_excel_filename(name):
        raise HTTPException(status_code=400, detail="非法的文件名")
    base = (Path(tempfile.gettempdir()) / "image" / session_id).resolve()
    target = (base / name).resolve()
    if not str(target).startswith(str(base)) or not target.is_file():
        raise HTTPException(status_code=404, detail="资产不存在")
    return FileResponse(
        target,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        filename=name,
    )
