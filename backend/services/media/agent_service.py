"""Media Agent 流式服务：单次生成 + 漫剧管线（含人工确认）。"""

from __future__ import annotations

import asyncio
import datetime
import re
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any
from uuid import uuid4

from backend.core.config import get_settings
from backend.schemas.chat import ChatRequest
from backend.schemas.media import MediaGenerateBody
from backend.services.agent.worker.pending import (
    parse_interactive_reply,
    pop_pending_action,
    save_pending_action,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.media.comic_pipeline import (
    build_comic_pipeline,
    resolve_default_media_models,
)
from backend.services.media.dashscope import generate_media, resolve_media_api_base
from backend.services.media.rate_limit import throttle_media_request
from backend.services.media.volcengine import resolve_volcengine_base
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
                "createdAt": datetime.datetime.now(datetime.UTC).isoformat(),
            },
        }
    )


def _media_emit(queue: asyncio.Queue[str | None]):
    """把管线生命周期事件转成 SSE 帧放进队列。"""

    async def emit(_kind: str, payload: dict[str, object]) -> None:
        """把生命周期事件编码为 SSE 帧放入响应队列。"""
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
                        "createdAt": datetime.datetime.now(datetime.UTC).isoformat(),
                    },
                }
            )
        )

    return emit


async def _drain_graph(
    graph,
    initial: dict[str, object],
    queue: asyncio.Queue[str | None],
    state_out: list[dict[str, object]],
) -> AsyncIterator[str]:
    """运行 LangGraph 并实时逐帧转发 SSE 帧，结束时把最终状态写入 state_out。

    生命周期事件在生产端（emit 回调）是实时的，转发必须同样实时——
    漫剧生成可达数分钟，攒到最后一次性吐出会让前端全程无进度可看。
    """

    async def runner() -> dict[str, object]:
        """执行 LangGraph 工作流，结束时向队列投递结束哨兵。"""
        try:
            return await graph.ainvoke(initial)
        finally:
            queue.put_nowait(None)

    task = asyncio.create_task(runner())
    while True:
        while not queue.empty():
            frame = queue.get_nowait()
            if frame is None:
                state_out.append(await task)
                return
            yield frame
        if task.done():
            state_out.append(await task)
            return
        await asyncio.sleep(0.05)


async def _stream_direct_media(
    *,
    body: ChatRequest,
    credentials: LlmCredentials,
    preferred_model_id: str,
    user_text: str,
) -> AsyncIterator[str]:
    """单次文生图/文生视频（漫剧之外的普通媒体请求）。"""

    is_video = "视频" in user_text or "动画" in user_text
    mode = "text-to-video" if is_video else "text-to-image"
    model_id, fallback_used = _resolve_media_model_id(preferred_model_id, mode)
    provider = str(model_id).split(":", 1)[0] or "qwen"
    if fallback_used:
        yield _lifecycle_frame(
            f"所选模型不支持{mode.replace('text-', '')}，已回退内置模型 {model_id}"
        )
    yield _lifecycle_frame(f"正在调用 {model_id} 生成媒体内容…")
    api_key = credentials.get(provider)
    if not api_key:
        yield encode_sse({"type": "TEXT", "content": f"缺少 {provider} API Key，无法生成媒体。"})
        return
    prompt = re.sub(r"^(帮我|请|生成|画|做|来|一个|一张|一段|个|条)", "", user_text).strip()
    prompt = prompt or user_text
    await throttle_media_request()
    endpoint = credentials.get_endpoint(provider)
    api_base = (
        resolve_volcengine_base(endpoint)
        if provider == "doubao"
        else resolve_media_api_base(endpoint)
    )
    result = await generate_media(
        MediaGenerateBody(
            model_id=model_id,
            mode=mode,
            prompt=prompt,
            negative_prompt="3D 渲染，CGI，塑料质感，写实照片" if not is_video else None,
            size=None if is_video else "1280*720",
        ),
        api_key,
        api_base,
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


def _resolve_comic_image_model(
    preferred_model_id: str,
    media_image_model_id: str,
) -> str:
    """解析漫剧出图模型：显式指定 > 会话所选媒体模型 > env 默认。

    preferred_model_id 是聊天模型选择器的值；只有当它恰好是支持出图的
    媒体模型时才复用，否则回退默认（聊天模型只用于编剧文本生成）。
    """

    from backend.services.media.catalog import get_media_model

    for candidate in (media_image_model_id, preferred_model_id):
        selected = (candidate or "").strip()
        if not selected or selected == "auto":
            continue
        try:
            model = get_media_model(selected)
        except ValueError:
            continue
        if "text-to-image" in (model.get("modes") or []):
            return selected
    image_model_id, _video_model_id = resolve_default_media_models()
    return image_model_id


def _resolve_comic_video_model(
    preferred_model_id: str,
    media_video_model_id: str,
) -> str:
    """解析漫剧视频模型：显式指定 > 会话所选媒体模型 > env 默认。"""

    from backend.services.media.catalog import get_media_model

    for candidate in (media_video_model_id, preferred_model_id):
        selected = (candidate or "").strip()
        if not selected or selected == "auto":
            continue
        try:
            model = get_media_model(selected)
        except ValueError:
            continue
        if "image-to-video" in (model.get("modes") or []):
            return selected
    _image_model_id, video_model_id = resolve_default_media_models()
    return video_model_id


def _resolve_media_model_id(
    preferred_model_id: str,
    mode: str,
) -> tuple[str, bool]:
    """解析本次媒体生成的模型：用户选择优先，不支持当前模式时回退内置默认。"""

    selected = (preferred_model_id or "").strip()
    default_image_model, default_video_model = resolve_default_media_models()
    if not selected or selected == "auto":
        return (default_video_model if mode == "text-to-video" else default_image_model), False
    from backend.services.media.catalog import get_media_model

    try:
        model = get_media_model(selected)
        if mode in (model.get("modes") or []):
            return selected, False
    except ValueError:
        pass
    return (default_video_model if mode == "text-to-video" else default_image_model), True


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
        image_model_id=_resolve_comic_image_model(preferred_model_id, body.media_image_model_id),
        video_model_id=_resolve_comic_video_model(preferred_model_id, body.media_video_model_id),
        emit=_media_emit(queue),
    )
    # 产物持久化在数据目录 media-cache 下：重启不丢、历史会话可回放。
    output_dir = str(get_settings().data_dir / "media-cache" / (body.session_id or "default"))
    initial: dict[str, object] = {
        "script": user_text,
        "title": "",
        "characters": [],
        "storyboard": [],
        "shots": [],
        "confirmed": False,
        "output_dir": output_dir,
        "merged_path": None,
        "report": {},
        "errors": [],
    }
    state_holder: list[dict[str, object]] = []
    async for frame in _drain_graph(graph, initial, queue, state_holder):
        yield frame
    state = state_holder[0] if state_holder else {}
    storyboard = state.get("storyboard") or []
    if not storyboard:
        yield _lifecycle_frame("分镜生成失败，请调整剧本后重试。", status="failed")
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
            "characters": state.get("characters") or [],
            "outputDir": output_dir,
        },
    )
    preview = "\n".join(
        f"{shot.get('index')}. [{shot.get('shot_type', '中景')}] {shot.get('title')}（{shot.get('duration', 5)}s）"
        f"{'：' + shot.get('dialogue', '')[:40] if shot.get('dialogue') else ''}"
        for shot in storyboard
    )
    character_names = "、".join(
        str(item.get("name") or "") for item in (state.get("characters") or [])
    )
    yield encode_sse(
        {
            "type": "INTERACTIVE_REQUEST",
            "payload": {
                "id": request_id,
                "source": "media_storyboard",
                "command": "confirm_storyboard",
                "prompt": f"分镜表已生成（{len(storyboard)} 个镜头），确认后开始生成？\n{preview}",
                "description": (
                    f"《{state.get('title') or '未命名漫剧'}》分镜确认"
                    + (f"；角色：{character_names}" if character_names else "")
                    + "；确认后将以角色设定图保持跨镜一致性"
                ),
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
                "toolArguments": {
                    "storyboardCount": len(storyboard),
                    "storyboard": storyboard,
                    "characters": state.get("characters") or [],
                },
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
        yield _lifecycle_frame("已取消漫剧生成。", status="canceled")
        yield encode_sse({"type": "TEXT", "content": "已取消漫剧生成。"})
        return

    storyboard = action.get("storyboard") or []
    characters = action.get("characters") or []
    output_dir = str(action.get("outputDir") or "")
    if output_dir:
        Path(output_dir).mkdir(parents=True, exist_ok=True)
    queue: asyncio.Queue[str | None] = asyncio.Queue()
    graph = build_comic_pipeline(
        credentials=credentials,
        preferred_model_id=preferred_model_id,
        image_model_id=_resolve_comic_image_model(preferred_model_id, body.media_image_model_id),
        video_model_id=_resolve_comic_video_model(preferred_model_id, body.media_video_model_id),
        emit=_media_emit(queue),
    )
    initial: dict[str, object] = {
        "script": str(action.get("script") or ""),
        "title": "",
        "characters": characters,
        "storyboard": storyboard,
        "shots": [],
        "confirmed": True,
        "output_dir": output_dir,
        "merged_path": None,
        "report": {},
        "errors": [],
    }
    state_holder: list[dict[str, object]] = []
    async for frame in _drain_graph(graph, initial, queue, state_holder):
        yield frame
    state = state_holder[0] if state_holder else {}

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
    summary.append("全部通过" if passed else "存在失败分镜")
    tts_count = int(report.get("ttsOk") or 0)
    if tts_count:
        summary.append(f"台词配音 {tts_count} 段")
    if report.get("subtitleBurned"):
        summary.append("字幕已烧录进成片")

    attachments: list[dict[str, Any]] = []
    for character in state.get("characters") or []:
        sheet = character.get("image")
        if isinstance(sheet, dict) and sheet.get("dataUrl"):
            named = dict(sheet)
            named["name"] = f"角色设定-{character.get('name', '角色')}.png"
            named["downloadName"] = named["name"]
            attachments.append(named)
    for shot in state.get("shots") or []:
        image = shot.get("image")
        if isinstance(image, dict) and image.get("dataUrl"):
            attachments.append(dict(image))
    srt_path = Path(output_dir) / "episode.srt"
    if srt_path.is_file():
        attachments.append(
            {
                "name": "episode.srt",
                "downloadName": "episode.srt",
                "type": "application/x-subrip",
                "assetKind": "file",
                "url": f"/api/media/asset/{body.session_id}/episode.srt",
            }
        )
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
    yield _lifecycle_frame(
        "漫剧生成结束" if passed else str(report.get("reason") or "漫剧生成失败：存在失败分镜"),
        status="completed" if passed else "failed",
    )
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
            preferred_model_id=preferred_model_id,
            user_text=user_text,
        ):
            yield frame
    except Exception as exc:  # noqa: BLE001
        yield _lifecycle_frame(f"媒体生成失败：{exc}", status="failed")
        yield encode_sse({"type": "TEXT", "content": f"❌ 媒体生成失败：{exc}"})


__all__ = ["stream_media_agent"]
