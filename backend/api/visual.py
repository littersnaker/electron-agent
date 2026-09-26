"""视觉 Review 接口：dev server 受控通道 + 滚动截图多帧交给视觉模型分析。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import Field

from backend.schemas.common import FlexibleModel
from backend.services.llm.credentials import resolve_credentials
from backend.services.visual.dev_server import start_dev_server, stop_dev_server
from backend.services.visual.verify import ReviewFrame, review_screenshots

router = APIRouter(tags=["visual"])

# 模块级保存 dev server 进程句柄：视觉验证期间存活，验证完/超时回收。
_DEV_SERVER_HANDLE: dict[str, Any] = {}


class ReviewFrameBody(FlexibleModel):
    """单帧滚动截图（内存 Base64，不落盘）。"""

    image_base64: str = Field(alias="imageBase64", min_length=1)
    mime_type: str = Field(default="image/png", alias="mimeType")


class VisualReviewBody(FlexibleModel):
    """视觉 Review 请求体：多帧截图 + 任务摘要 + 可选模型指定。"""

    frames: list[ReviewFrameBody] = Field(min_length=1, max_length=12)
    task_summary: str = Field(default="", alias="taskSummary", max_length=4000)
    # 不传时由网关在带图请求下自动挑选 supportsVision 的候选模型。
    model_id: str = Field(default="", alias="modelId", max_length=200)


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


@router.post("/api/visual/review")
async def post_visual_review(body: VisualReviewBody, request: Request) -> dict[str, Any]:
    """把多帧滚动截图交给视觉模型审查，返回结论文本。"""

    credentials = resolve_credentials(request)
    result = await review_screenshots(
        frames=[
            ReviewFrame(data=frame.image_base64, mime_type=frame.mime_type)
            for frame in body.frames
        ],
        task_summary=body.task_summary,
        credentials=credentials,
        model_id=body.model_id,
    )
    if not result.get("ok"):
        return {"ok": False, "error": result.get("error") or "视觉 Review 失败"}
    return {
        "ok": True,
        "model": result.get("model") or "",
        "content": result.get("content") or "",
        "frameCount": result.get("frameCount") or 0,
        "usage": result.get("usage") or {},
    }
