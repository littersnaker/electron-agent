"""AI 漫剧 LangGraph 管线。

节点：编剧 → 分镜确认（人工）→ 分镜并行出图 → 并行图生视频 → 合并 → 质检。
同一分镜失败只重跑该镜（图/视频各重试一次），不重跑整集。
"""

from __future__ import annotations

import asyncio
import json
import operator
import os
from pathlib import Path
from typing import Annotated, Any, Awaitable, Callable, TypedDict

import httpx

from backend.schemas.media import MediaGenerateBody
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage
from backend.services.media.dashscope import generate_media, resolve_media_api_base
from backend.services.media.volcengine import resolve_volcengine_base
from backend.services.media.rate_limit import throttle_media_request
from backend.services.media.video_merge import merge_videos

EmitCallback = Callable[[str, dict[str, Any]], Awaitable[None]]

IMAGE_MODEL_ID = os.getenv("MEDIA_IMAGE_MODEL", "qwen:qwen-image-2.0-pro")
VIDEO_MODEL_ID = os.getenv("MEDIA_VIDEO_MODEL", "qwen:wan2.7-i2v-2026-04-25")
MAX_PARALLEL_MEDIA = int(os.getenv("MEDIA_MAX_PARALLEL", "1"))

_WRITER_SYSTEM = """你是漫剧分镜编剧。把用户剧本改写成完整分镜表，只返回 JSON：
{"title":"剧名","shots":[{"title":"分镜标题","image_prompt":"文生图提示词（画面构图、场景、角色、镜头），要求 2D 动漫风格","video_prompt":"图生视频提示词（动态动作、镜头运动），简短","negative_prompt":"该镜要排除的元素，逗号分隔"}]}
分镜 6-12 个，每个镜头一句话画面描述，不要输出 Markdown。"""


class ComicShot(TypedDict):
    """单个分镜的产出记录。"""

    index: int
    title: str
    image_prompt: str
    video_prompt: str
    negative_prompt: str
    image: dict[str, Any] | None
    video: dict[str, Any] | None
    video_file: str | None
    status: str
    error: str


class ComicState(TypedDict):
    """漫剧任务整体状态。"""

    script: str
    title: str
    storyboard: list[dict[str, Any]]
    shots: Annotated[list[ComicShot], operator.add]
    confirmed: bool
    output_dir: str
    merged_path: str | None
    report: dict[str, Any]
    errors: list[str]


async def _extract_storyboard(text: str) -> tuple[str, list[dict[str, Any]]]:
    """解析编剧模型返回的分镜 JSON。"""

    stripped = text.strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        raise ValueError("编剧未返回分镜 JSON")
    payload = json.loads(stripped[start : end + 1])
    shots = payload.get("shots") or []
    if not isinstance(shots, list) or not shots:
        raise ValueError("分镜表为空")
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(shots, start=1):
        if not isinstance(raw, dict):
            continue
        normalized.append(
            {
                "index": int(raw.get("index") or index),
                "title": str(raw.get("title") or f"分镜 {index}")[:80],
                "image_prompt": str(raw.get("image_prompt") or "")[:1000],
                "video_prompt": str(raw.get("video_prompt") or "")[:500],
                "negative_prompt": str(raw.get("negative_prompt") or "")[:500],
            }
        )
    if not normalized:
        raise ValueError("分镜表为空")
    return str(payload.get("title") or "未命名漫剧")[:80], normalized


def build_comic_pipeline(
    *,
    credentials: LlmCredentials,
    preferred_model_id: str,
    emit: EmitCallback,
    image_model_id: str = IMAGE_MODEL_ID,
    video_model_id: str = VIDEO_MODEL_ID,
):
    """构建并编译 LangGraph 漫剧管线（每次调用独立编译，便于注入 emit）。"""

    from langgraph.graph import END, START, StateGraph
    from langgraph.types import Send

    semaphore = asyncio.Semaphore(MAX_PARALLEL_MEDIA)

    async def lifecycle(detail: str, status: str = "running") -> None:
        await emit(
            "lifecycle",
            {
                "role": "media_agent",
                "agentId": "media_agent",
                "status": status,
                "detail": detail,
            },
        )

    async def writer_node(state: ComicState) -> dict[str, Any]:
        """编剧：剧本 → 分镜表（已确认恢复时跳过）。"""

        if state.get("storyboard"):
            return {"storyboard": state["storyboard"]}
        await lifecycle("正在把剧本拆分为分镜表…")
        text, _usage, _model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[
                LlmMessage("system", _WRITER_SYSTEM),
                LlmMessage("user", state["script"]),
            ],
            temperature=0.7,
            timeout_seconds=120,
            audit={"agentId": "media_agent", "agentRole": "comic_writer"},
        )
        title, storyboard = await _extract_storyboard(text)
        await lifecycle(f"已完成分镜表：{len(storyboard)} 个镜头")
        return {"title": title, "storyboard": storyboard}

    def after_writer(state: ComicState) -> str:
        """人工确认通过后进入并行分镜，否则结束（等用户确认）。"""

        if not state.get("confirmed"):
            return END
        return [
            Send(
                "process_shot",
                {
                    "shot": shot,
                    "output_dir": state["output_dir"],
                    "seed_base": 1000 + int(shot.get("index") or 1),
                    "semaphore": semaphore,
                },
            )
            for shot in state["storyboard"]
        ]

    async def process_shot(payload: dict[str, Any]) -> dict[str, Any]:
        """单镜：文生图 → 图生视频 → 下载本地（失败各重试一次）。"""

        shot: dict[str, Any] = payload["shot"]
        output_dir = Path(payload["output_dir"])
        seed = int(payload["seed_base"] or 1001)
        semaphore = payload["semaphore"]
        index = int(shot.get("index") or 1)
        record: ComicShot = {
            "index": index,
            "title": shot.get("title", ""),
            "image_prompt": shot.get("image_prompt", ""),
            "video_prompt": shot.get("video_prompt", ""),
            "negative_prompt": shot.get("negative_prompt", ""),
            "image": None,
            "video": None,
            "video_file": None,
            "status": "pending",
            "error": "",
        }
        provider = str(image_model_id).split(":", 1)[0] or "qwen"
        api_key = credentials.get(provider)
        endpoint = credentials.get_endpoint(provider)
        api_base = (
            resolve_volcengine_base(endpoint)
            if provider == "doubao"
            else resolve_media_api_base(endpoint)
        )
        if not api_key:
            record["status"] = "failed"
            record["error"] = f"缺少 {provider} API Key"
            return {"shots": [record]}

        await lifecycle(f"分镜 {index}：生成画面…")
        image_attachment: dict[str, Any] | None = None
        for attempt in range(2):
            try:
                async with semaphore:
                    await throttle_media_request()
                    image_result = await generate_media(
                        MediaGenerateBody(
                            model_id=image_model_id,
                            mode="text-to-image",
                            prompt=shot.get("image_prompt", ""),
                            negative_prompt=(
                                f"{shot.get('negative_prompt', '')}，3D 渲染，CGI，"
                                "塑料质感，写实照片"
                            ),
                            seed=seed + attempt,
                            size="1280*720",
                        ),
                        api_key,
                        api_base,
                    )
                attachments = image_result.get("attachments") or []
                if attachments:
                    image_attachment = attachments[0]
                    break
            except Exception as exc:  # noqa: BLE001
                record["error"] = f"出图失败：{exc}"
                await asyncio.sleep(
                    10 + attempt * 10 if "429" in str(exc) else 2 + attempt * 2
                )
        if not image_attachment:
            record["status"] = "failed"
            return {"shots": [record]}
        record["image"] = image_attachment
        await lifecycle(f"分镜 {index}：画面完成，开始生成视频…")

        video_attachment: dict[str, Any] | None = None
        for attempt in range(2):
            try:
                async with semaphore:
                    await throttle_media_request()
                    video_result = await generate_media(
                        MediaGenerateBody(
                            model_id=video_model_id,
                            mode="image-to-video",
                            prompt=shot.get("video_prompt", ""),
                            seed=seed + attempt,
                            attachment=image_attachment,
                        ),
                        api_key,
                        api_base,
                    )
                attachments = video_result.get("attachments") or []
                if attachments:
                    video_attachment = attachments[0]
                    break
            except Exception as exc:  # noqa: BLE001
                record["error"] = f"视频生成失败：{exc}"
                await asyncio.sleep(
                    10 + attempt * 10 if "429" in str(exc) else 2 + attempt * 2
                )
        if not video_attachment:
            record["status"] = "failed"
            return {"shots": [record]}
        record["video"] = video_attachment

        video_file = output_dir / f"shot_{index:02d}.mp4"
        try:
            url = str(video_attachment.get("url") or "")
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(120.0), follow_redirects=True
            ) as client:
                response = await client.get(url)
                response.raise_for_status()
                video_file.write_bytes(response.content)
            record["video_file"] = video_file.as_posix()
            record["status"] = "succeeded"
        except Exception as exc:  # noqa: BLE001
            record["status"] = "failed"
            record["error"] = f"视频下载失败：{exc}"
        await lifecycle(f"分镜 {index}：完成", status="running")
        return {"shots": [record]}

    async def merge_node(state: ComicState) -> dict[str, Any]:
        """把成功分镜视频按顺序合并为一集。"""

        ordered = sorted(state["shots"], key=lambda shot: int(shot["index"]))
        videos = [shot["video_file"] for shot in ordered if shot.get("video_file")]
        if not videos:
            return {
                "report": {
                    "passed": False,
                    "merged": False,
                    "reason": "没有可合并的分镜视频",
                }
            }
        await lifecycle(f"正在合并 {len(videos)} 个分镜视频…")

        def progress(current: int, total: int) -> None:
            asyncio.create_task(
                lifecycle(f"合并进度 {current}/{total}")
            )

        try:
            merged = await merge_videos(
                videos,
                str(Path(state["output_dir"]) / "episode.mp4"),
                on_progress=progress,
            )
            return {"merged_path": str(merged.get("outputPath") or "")}
        except Exception as exc:  # noqa: BLE001
            return {
                "report": {
                    "passed": False,
                    "merged": False,
                    "reason": f"合并失败：{exc}",
                }
            }

    async def quality_node(state: ComicState) -> dict[str, Any]:
        """质检：产物存在 + 分镜全部成功。"""

        shots = state.get("shots") or []
        failed = [shot for shot in shots if shot.get("status") != "succeeded"]
        merged_path = state.get("merged_path")
        merged_ok = bool(merged_path and Path(merged_path).is_file())
        report = {
            "passed": merged_ok and not failed,
            "merged": merged_ok,
            "shotTotal": len(shots),
            "shotFailed": len(failed),
            "mergedPath": merged_path,
        }
        if failed:
            report["reason"] = "；".join(
                f"分镜{s.get('index')}：{s.get('error')}" for s in failed
            )[:2000]
        return {"report": report}

    graph = StateGraph(ComicState)
    graph.add_node("writer", writer_node)
    graph.add_node("process_shot", process_shot)
    graph.add_node("merge", merge_node)
    graph.add_node("quality", quality_node)
    graph.add_edge(START, "writer")
    graph.add_conditional_edges("writer", after_writer, ["process_shot", END])
    graph.add_edge("process_shot", "merge")
    graph.add_edge("merge", "quality")
    graph.add_edge("quality", END)
    return graph.compile()


__all__ = [
    "ComicState",
    "build_comic_pipeline",
]
