"""Media Agent 流式服务：单次生成 + 漫剧管线（含人工确认）。"""

from __future__ import annotations

import asyncio
import datetime
import re
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from uuid import uuid4

from backend.schemas.chat import ChatRequest
from backend.schemas.media import MediaGenerateBody
from backend.services.agent.pending import (
    parse_interactive_reply,
    pop_pending_action,
    save_pending_action,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.media.comic_pipeline import (
    IMAGE_MODEL_ID,
    VIDEO_MODEL_ID,
    build_comic_pipeline,
)
from backend.services.media.dashscope import generate_media, resolve_media_api_base
from backend.services.media.rate_limit import throttle_media_request
from backend.utils.sse import encode_sse, encode_sse_comment

_COMIC_INTENT = re.compile(r"漫剧|分镜|剧本|漫画|分鏡|storyboard", re.IGNORECASE)
_REPLY_PATTERN = re.compile(r"^\[INTERACTIVE_REPLY\]", re.IGNORECASE)


def _last_user_text(body: ChatRequest) -> str:
    for message in reversed(body.messages):
        if message.role == "user":
            return message.content.strip()
    return ""


def _is_comic_intent(text: str) -> bool:
    return bool(_COMIC_INTENT.search(text))


def _lifecycle_frame(detail: str, status: str = "running") -> str:
    return encode_sse(
        {
            "type": "AGENT_LIFECYCLE",
            "payload": {
                "id": f"media_life_{uuid4().hex}",
                "agentId": "media_agent",
                "role": "media_agent",
                "status": status.upper(),
                "iteration": 0,
                "detail": detail,
                "createdAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            },
        }
    )


def _media_emit(queue: asyncio.Queue[str | None]):
    """把管线生命周期事件转成 SSE 帧放进队列。"""

    async def emit(_kind: str, payload: dict[str, object]) -> None:
        queue.put_nowait(
            encode_sse(
                {
                    "type": "AGENT_LIFECYCLE",
                    "payload": {
                        "id": f"media_life_{uuid4().hex}",
                        "agentId": "media_agent",
                        "role": "media_agent",
                        "status": str(payload.get("status") or "running").upper(),
                        "iteration": 0,
                        "detail": str(payload.get("detail") or ""),
                        "createdAt": datetime.datetime.now(
                            datetime.timezone.utc
                        ).isoformat(),
                    },
                }
            )
        )

    return emit


async def _drain_graph(
    graph,
    initial: dict[str, object],
    queue: asyncio.Queue[str | None],
) -> tuple[dict[str, object], list[str]]:
    """运行 LangGraph，边跑边吐 SSE 帧。"""

    async def runner() -> dict[str, object]:
        try:
            return await graph.ainvoke(initial)
        finally:
            queue.put_nowait(None)

    task = asyncio.create_task(runner())
    frames: list[str] = []
    while True:
        while not queue.empty():
            frame = queue.get_nowait()
            if frame is None:
                state = await task
                return state, frames
            frames.append(frame)
        if task.done():
            state = await task
            return state, frames
        await asyncio.sleep(0.05)


async def _stream_direct_media(
    *,
    body: ChatRequest,
    credentials: LlmCredentials,
    user_text: str,
) -> AsyncIterator[str]:
    """单次文生图/文生视频（漫剧之外的普通媒体请求）。"""

    yield _lifecycle_frame("正在调用 qwen 生成媒体内容…")
    api_key = credentials.get("qwen")
    if not api_key:
        yield encode_sse({"type": "TEXT", "content": "缺少 qwen API Key，无法生成媒体。"})
        return
    is_video = "视频" in user_text or "动画" in user_text
    prompt = re.sub(r"^(帮我|请|生成|画|做|来|一个|一张|一段|个|条)", "", user_text).strip()
    prompt = prompt[:1200] or user_text[:1200]
    await throttle_media_request()
    result = await generate_media(
        MediaGenerateBody(
            model_id=VIDEO_MODEL_ID if is_video else IMAGE_MODEL_ID,
            mode="text-to-video" if is_video else "text-to-image",
            prompt=prompt,
            negative_prompt="3D 渲染，CGI，塑料质感，写实照片" if not is_video else None,
            size=None if is_video else "1280*720",
        ),
        api_key,
        resolve_media_api_base(credentials.get_endpoint("qwen")),
    )
    attachments = result.get("attachments") or []
    yield _lifecycle_frame("生成完成", status="completed")
    yield encode_sse(
        {
            "type": "MEDIA_RESULT",
            "content": result.get("content") or "媒体生成完成",
            "attachments": attachments,
        }
    )


async def _stream_storyboard(
    *,
    body: ChatRequest,
    credentials: LlmCredentials,
    preferred_model_id: str,
    user_text: str,
) -> AsyncIterator[str]:
    """漫剧第一阶段：编剧拆分子镜 → 请求人工确认。"""

    yield _lifecycle_frame("开始漫剧制作，正在拆分子镜…")
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    graph = build_comic_pipeline(
        credentials=credentials,
        preferred_model_id=preferred_model_id,
        emit=_media_emit(queue),
    )
    output_dir = str(
        Path(tempfile.gettempdir())
        / "media"
        / (body.session_id or "default")
    )
    initial: dict[str, object] = {
        "script": user_text,
        "title": "",
        "storyboard": [],
        "shots": [],
        "confirmed": False,
        "output_dir": output_dir,
        "merged_path": None,
        "report": {},
        "errors": [],
    }
    state, frames = await _drain_graph(graph, initial, queue)
    for frame in frames:
        yield frame
    storyboard = state.get("storyboard") or []
    if not storyboard:
        yield encode_sse({"type": "TEXT", "content": "分镜生成失败，请调整剧本后重试。"})
        return

    request_id = f"comic_{uuid4().hex}"
    await save_pending_action(
        request_id=request_id,
        session_id=body.session_id,
        project_id=body.project_id,
        action={
            "kind": "comic_storyboard",
            "script": user_text,
            "storyboard": storyboard,
            "outputDir": output_dir,
        },
    )
    preview = "\n".join(
        f"{shot.get('index')}. {shot.get('title')}：{shot.get('image_prompt', '')[:60]}"
        for shot in storyboard
    )
    yield encode_sse(
        {
            "type": "INTERACTIVE_REQUEST",
            "payload": {
                "id": request_id,
                "source": "media_storyboard",
                "command": "confirm_storyboard",
                "prompt": f"分镜表已生成（{len(storyboard)} 个镜头），确认后开始生成？\n{preview}",
                "description": f"《{state.get('title') or '未命名漫剧'}》分镜确认",
                "mode": "normal",
                "suggestedMode": "user",
                "kind": "confirm",
                "allowMultiple": False,
                "options": [
                    {"label": "确认并开始生成", "value": "approve"},
                    {"label": "拒绝", "value": "reject"},
                ],
                "promptRound": 1,
                "recentOutput": preview,
                "title": "分镜表确认",
                "approvalKind": "comic_storyboard",
                "toolName": "media_pipeline",
                "toolArguments": {"storyboardCount": len(storyboard)},
            },
        }
    )
    yield _lifecycle_frame("等待确认分镜表…", status="blocked")


async def _resume_comic(
    *,
    body: ChatRequest,
    credentials: LlmCredentials,
    preferred_model_id: str,
    user_text: str,
) -> AsyncIterator[str]:
    """人工确认后第二阶段：并行出图 → 图生视频 → 合并 → 质检。"""

    request_id, _mode, answer = parse_interactive_reply(user_text)
    action = await pop_pending_action(request_id)
    approved = str(answer or "").strip().lower() in {"approve", "yes", "确认", "同意"}
    if not approved or not action or action.get("kind") != "comic_storyboard":
        yield encode_sse({"type": "TEXT", "content": "已取消漫剧生成。"})
        return

    storyboard = action.get("storyboard") or []
    output_dir = str(action.get("outputDir") or "")
    if output_dir:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    graph = build_comic_pipeline(
        credentials=credentials,
        preferred_model_id=preferred_model_id,
        emit=_media_emit(queue),
    )
    initial: dict[str, object] = {
        "script": str(action.get("script") or ""),
        "title": "",
        "storyboard": storyboard,
        "shots": [],
        "confirmed": True,
        "output_dir": output_dir,
        "merged_path": None,
        "report": {},
        "errors": [],
    }
    state, frames = await _drain_graph(graph, initial, queue)
    for frame in frames:
        yield frame

    report = state.get("report") or {}
    passed = bool(report.get("passed"))
    merged_path = report.get("mergedPath")
    summary = []
    if merged_path:
        summary.append(f"漫剧已合并：{merged_path}")
    if report.get("shotFailed"):
        summary.append(f"失败分镜 {report.get('shotFailed')} 个：{report.get('reason')}")
        reason_text = str(report.get("reason") or "")
        if "429" in reason_text:
            summary.append(
                "提示：并发触发了百炼限流，已自动退避重试；可调低 MEDIA_MAX_PARALLEL 或稍后再试。"
            )
        if "403" in reason_text or "quota" in reason_text.lower():
            summary.append(
                "提示：视频模型免费额度已用完，请在百炼控制台充值或关闭“仅免费额度”模式；"
                "或设置环境变量 MEDIA_VIDEO_MODEL 换用其他视频模型。"
            )
    summary.append("✅ 全部通过" if passed else "⚠️ 存在失败分镜")

    attachments: list[dict[str, Any]] = []
    for shot in state.get("shots") or []:
        image = shot.get("image")
        if isinstance(image, dict) and image.get("dataUrl"):
            attachments.append(dict(image))
    if merged_path:
        attachments.append(
            {
                "name": "episode.mp4",
                "downloadName": "episode.mp4",
                "type": "video/mp4",
                "assetKind": "video",
                "url": f"/api/media/asset/{body.session_id}/episode.mp4",
            }
        )
    yield _lifecycle_frame("漫剧生成结束", status="completed")
    if attachments:
        yield encode_sse(
            {
                "type": "MEDIA_RESULT",
                "content": "\n".join(summary),
                "attachments": attachments,
            }
        )
    else:
        yield encode_sse({"type": "TEXT", "content": "\n".join(summary)})


async def stream_media_agent(
    *,
    body: ChatRequest,
    credentials: LlmCredentials,
    preferred_model_id: str,
) -> AsyncIterator[str]:
    """Media Agent 统一入口。"""

    yield encode_sse_comment()
    user_text = _last_user_text(body)
    if not user_text:
        yield encode_sse({"type": "TEXT", "content": "请描述要生成的内容。"})
        return
    try:
        if _REPLY_PATTERN.search(user_text):
            async for frame in _resume_comic(
                body=body,
                credentials=credentials,
                preferred_model_id=preferred_model_id,
                user_text=user_text,
            ):
                yield frame
            return
        if _is_comic_intent(user_text):
            async for frame in _stream_storyboard(
                body=body,
                credentials=credentials,
                preferred_model_id=preferred_model_id,
                user_text=user_text,
            ):
                yield frame
            return
        async for frame in _stream_direct_media(
            body=body,
            credentials=credentials,
            user_text=user_text,
        ):
            yield frame
    except Exception as exc:  # noqa: BLE001
        yield encode_sse({"type": "TEXT", "content": f"❌ 媒体生成失败：{exc}"})


__all__ = ["stream_media_agent"]
