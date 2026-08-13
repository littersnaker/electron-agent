"""视觉验证接口：接收内存截图 Base64，交给 GLM-4.6V 分析。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field

from backend.schemas.common import FlexibleModel
from backend.services.llm.credentials import resolve_credentials
from backend.services.visual.dev_server import start_dev_server, stop_dev_server
from backend.services.visual.verify import analyze_screenshot, build_verify_prompt

router = APIRouter(tags=["visual"])

# 模块级保存 dev server 进程句柄：视觉验证期间存活，验证完/超时回收。
_DEV_SERVER_HANDLE: dict[str, Any] = {}


class VisualVerifyBody(FlexibleModel):
    """视觉验证请求体（截图全程内存传递，不落盘）。"""

    image_base64: str = Field(alias="imageBase64", min_length=1)
    mime_type: str = Field(default="image/png", alias="mimeType")
    task_summary: str = Field(default="", alias="taskSummary", max_length=4000)
    acceptance: list[str] = Field(default_factory=list, max_length=16)


class VisualPreviewBody(FlexibleModel):
    """启动项目 dev server 供截图预览。"""

    root_path: str = Field(alias="rootPath", min_length=1)


@router.post("/api/visual/preview")
async def post_visual_preview(body: VisualPreviewBody) -> dict[str, Any]:
    """启动项目 dev server 并返回访问地址（视觉验证专用受控通道）。"""

    from pathlib import Path

    root = Path(body.root_path).resolve()
    if not root.is_dir():
        raise HTTPException(status_code=400, detail="项目目录不存在")
    # 若已有运行中的 dev server 直接复用，避免重复启动。
    existing = _DEV_SERVER_HANDLE.get(str(root))
    if existing and existing.get("process") and existing["process"].returncode is None:
        return {"url": existing["url"], "port": existing["port"]}
    try:
        handle = await start_dev_server(root)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _DEV_SERVER_HANDLE[str(root)] = handle
    return {"url": handle["url"], "port": handle["port"]}


@router.post("/api/visual/preview/stop")
async def post_visual_preview_stop() -> dict[str, bool]:
    """回收所有视觉验证 dev server 进程。"""

    for key, handle in list(_DEV_SERVER_HANDLE.items()):
        await stop_dev_server(handle)
        _DEV_SERVER_HANDLE.pop(key, None)
    return {"ok": True}


@router.post("/api/visual/verify")
async def post_visual_verify(body: VisualVerifyBody, request: Request) -> dict[str, Any]:
    """分析一张截图并返回 GLM 视觉结论。"""

    prompt = build_verify_prompt(body.task_summary, body.acceptance)
    credentials = resolve_credentials(request)
    result = await analyze_screenshot(
        image_base64=body.image_base64,
        mime_type=body.mime_type,
        prompt=prompt,
        credentials=credentials,
    )
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error") or "视觉验证失败"}
    return {
        "ok": True,
        "model": result.get("model") or "",
        "content": result.get("content") or "",
        "usage": result.get("usage") or {},
    }
