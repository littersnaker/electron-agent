"""AI 漫剧 LangGraph 管线。

节点：编剧 → 角色设定（抽取角色卡 + 生成设定图）→ 分镜确认（人工）→
分镜并行出图（角色设定图作参考保证一致性）→ 并行图生视频 → 台词 TTS →
合并（音轨 + 字幕烧录 + 可选 BGM）→ 质检。
同一分镜失败只重跑该镜（图/视频各重试一次），不重跑整集。
"""

from __future__ import annotations

import asyncio
import json
import operator
import os
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Annotated, Any, TypedDict

import httpx

from backend.schemas.media import MediaGenerateBody
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage
from backend.services.media.asset_library import (
    character_content_hash,
    find_character_sheet,
    read_asset_data_url,
    save_character_sheet,
)
from backend.services.media.audio import build_srt, synthesize_dialogue
from backend.services.media.dashscope import generate_media, resolve_media_api_base
from backend.services.media.rate_limit import throttle_media_request
from backend.services.media.video_merge import merge_video_episode, merge_videos
from backend.services.media.volcengine import resolve_volcengine_base

EmitCallback = Callable[[str, dict[str, Any]], Awaitable[None]]

MAX_PARALLEL_MEDIA = int(os.getenv("MEDIA_MAX_PARALLEL", "1"))


def resolve_default_media_models() -> tuple[str, str]:
    """读取 env 默认的出图/视频模型（调用时读取，改 env 后无需改代码）。"""

    return (
        os.getenv("MEDIA_IMAGE_MODEL", "qwen:qwen-image-2.0-pro"),
        os.getenv("MEDIA_VIDEO_MODEL", "qwen:wan2.7-i2v-2026-04-25"),
    )


# 视频与出图参数：漫剧可整体切竖屏（9:16），单镜时长随分镜表透传。
VIDEO_RESOLUTION = os.getenv("MEDIA_VIDEO_RESOLUTION", "720P")
VIDEO_RATIO = os.getenv("MEDIA_VIDEO_RATIO", "16:9")
IMAGE_SIZE = os.getenv("MEDIA_IMAGE_SIZE", "1280*720")
BGM_PATH = os.getenv("MEDIA_BGM_PATH", "")

_WRITER_SYSTEM = """你是漫剧分镜编剧。把用户剧本改写成完整分镜表，只返回 JSON：
{"title":"剧名",
 "characters":[{"name":"角色名","appearance":"外貌：性别/年龄段/发型发色/五官/体型，2D 动漫风格，具体且可复现","outfit":"服装：颜色+款式"}],
 "shots":[{"title":"分镜标题","shot_type":"景别（远景/中景/近景/特写）",
 "image_prompt":"文生图提示词：场景+构图+出场角色（用角色名指代），要求 2D 动漫风格","video_prompt":"图生视频提示词（动作与镜头运动），简短","negative_prompt":"该镜要排除的元素，逗号分隔","dialogue":"本镜台词，格式 角色:台词，多条用换行；无台词留空","duration":4,"characters":["出场角色名"]}]}
分镜 6-12 个，单镜时长 2-6 秒，全片合计不超过 60 秒。不要输出 Markdown。"""

_CHARACTER_SYSTEM = """你是漫剧角色设计师。从剧本与分镜表提取出场角色卡，只返回 JSON：
{"characters":[{"name":"角色名","appearance":"外貌：性别/年龄段/发型发色/五官/体型，具体且可复现","outfit":"服装：颜色+款式"}]}
只提取有台词或明确戏份的主要角色，最多 4 个；用户剧本中已描述的外貌直接沿用。不要输出 Markdown。"""

_NORMAL_NEGATIVE = "3D 渲染，CGI，塑料质感，写实照片"


class ComicShot(TypedDict):
    """单个分镜的产出记录。"""

    index: int
    title: str
    shot_type: str
    image_prompt: str
    video_prompt: str
    negative_prompt: str
    dialogue: str
    duration: int
    characters: list[str]
    image: dict[str, Any] | None
    video: dict[str, Any] | None
    video_file: str | None
    audio_file: str | None
    status: str
    error: str


class ComicState(TypedDict):
    """漫剧任务整体状态。"""

    script: str
    title: str
    characters: list[dict[str, Any]]
    storyboard: list[dict[str, Any]]
    shots: Annotated[list[ComicShot], operator.add]
    confirmed: bool
    output_dir: str
    merged_path: str | None
    report: dict[str, Any]
    errors: list[str]


def _extract_json_object(text: str) -> dict[str, Any]:
    """从模型输出中截取第一个完整 JSON 对象。"""

    stripped = text.strip()
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start < 0 or end < start:
        raise ValueError("模型未返回 JSON")
    payload = json.loads(stripped[start : end + 1])
    if not isinstance(payload, dict):
        raise ValueError("模型返回的不是 JSON 对象")
    return payload


async def _extract_storyboard(
    text: str,
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    """解析编剧模型返回的分镜 JSON（含角色卡与丰富字段，缺省回退）。"""

    payload = _extract_json_object(text)
    shots = payload.get("shots") or []
    if not isinstance(shots, list) or not shots:
        raise ValueError("分镜表为空")
    raw_characters = payload.get("characters") or []
    characters = _normalize_characters(raw_characters)
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(shots, start=1):
        if not isinstance(raw, dict):
            continue
        shot_characters = raw.get("characters")
        duration = raw.get("duration")
        normalized.append(
            {
                "index": int(raw.get("index") or index),
                "title": str(raw.get("title") or f"分镜 {index}")[:80],
                "shot_type": str(raw.get("shot_type") or "中景")[:20],
                "image_prompt": str(raw.get("image_prompt") or "")[:1000],
                "video_prompt": str(raw.get("video_prompt") or "")[:500],
                "negative_prompt": str(raw.get("negative_prompt") or "")[:500],
                "dialogue": str(raw.get("dialogue") or "")[:300],
                "duration": max(2, min(10, int(duration) if duration else 5)),
                "characters": (
                    [str(item)[:40] for item in shot_characters][:4]
                    if isinstance(shot_characters, list)
                    else []
                ),
            }
        )
    if not normalized:
        raise ValueError("分镜表为空")
    return str(payload.get("title") or "未命名漫剧")[:80], characters, normalized


def _normalize_characters(raw: Any) -> list[dict[str, Any]]:
    """规范化角色卡列表（name/appearance/outfit），上限 4 个。"""

    characters: list[dict[str, Any]] = []
    if not isinstance(raw, list):
        return characters
    for item in raw:
        if len(characters) >= 4:
            break
        if not isinstance(item, dict):
            continue
        name = str(item.get("name") or "").strip()[:40]
        if not name:
            continue
        characters.append(
            {
                "name": name,
                "appearance": str(item.get("appearance") or "")[:400],
                "outfit": str(item.get("outfit") or "")[:200],
                "image": item.get("image") if isinstance(item.get("image"), dict) else None,
            }
        )
    return characters


def _media_provider_context(
    model_id: str,
    credentials: LlmCredentials,
) -> tuple[str, str | None]:
    """按模型 ID 解析其供应商的 API Key 与 API Base。

    图与视频模型可以来自不同供应商（如百炼出图 + 火山出视频），
    各自的 Key 均来自用户在设置里填写的对应供应商凭证。
    """

    provider = str(model_id).split(":", 1)[0] or "qwen"
    api_key = credentials.get(provider)
    endpoint = credentials.get_endpoint(provider)
    api_base = (
        resolve_volcengine_base(endpoint)
        if provider == "doubao"
        else resolve_media_api_base(endpoint)
    )
    return api_key, api_base


def build_comic_pipeline(
    *,
    credentials: LlmCredentials,
    preferred_model_id: str,
    emit: EmitCallback,
    image_model_id: str | None = None,
    video_model_id: str | None = None,
):
    """构建并编译 LangGraph 漫剧管线（每次调用独立编译，便于注入 emit）。

    ``image_model_id`` / ``video_model_id`` 为请求级覆盖；缺省回退 env 默认值
    （每次构建时读取，env 变更无需重启进程）。
    """

    env_image_model, env_video_model = resolve_default_media_models()
    image_model_id = image_model_id or env_image_model
    video_model_id = video_model_id or env_video_model

    from langgraph.graph import END, START, StateGraph
    from langgraph.types import Send

    semaphore = asyncio.Semaphore(MAX_PARALLEL_MEDIA)

    async def lifecycle(detail: str, status: str = "running") -> None:
        """发送媒体 Agent 生命周期事件（角色、状态与详情）。"""

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
        """编剧：剧本 → 分镜表 + 角色候选（已确认恢复时跳过）。"""

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
        title, characters, storyboard = await _extract_storyboard(text)
        await lifecycle(f"已完成分镜表：{len(storyboard)} 个镜头，{len(characters)} 个角色")
        return {"title": title, "characters": characters, "storyboard": storyboard}

    async def _generate_character_sheet(
        character: dict[str, Any], output_dir: Path, index: int
    ) -> dict[str, Any] | None:
        """为一个角色生成设定图（全身立绘，保证跨镜一致性锚点）。"""

        api_key, api_base = _media_provider_context(image_model_id, credentials)
        if not api_key:
            return None
        prompt = (
            f"角色设定图，全身立绘，白色纯色背景，正面站姿，柔和均匀打光，"
            f"2D 动漫风格：{character.get('name')}。外貌：{character.get('appearance')}。"
            f"服装：{character.get('outfit')}。单人，无文字。"
        )
        for attempt in range(2):
            try:
                async with semaphore:
                    await throttle_media_request()
                    result = await generate_media(
                        MediaGenerateBody(
                            model_id=image_model_id,
                            mode="text-to-image",
                            prompt=prompt,
                            negative_prompt=_NORMAL_NEGATIVE,
                            seed=100 + index * 10 + attempt,
                            size="1024*1024",
                        ),
                        api_key,
                        api_base,
                    )
                attachments = result.get("attachments") or []
                if attachments:
                    sheet = dict(attachments[0])
                    sheet["prompt"] = prompt  # 入角色库时记录完整出图提示词。
                    return sheet
            except Exception as exc:  # noqa: BLE001
                record_error = f"角色 {character.get('name')} 设定图失败：{exc}"
                await lifecycle(record_error)
                await asyncio.sleep(10 + attempt * 10 if "429" in str(exc) else 2 + attempt * 2)
        return None

    async def character_design_node(state: ComicState) -> dict[str, Any]:
        """角色设计：抽取角色卡并生成设定图（已确认恢复时跳过）。"""

        existing = state.get("characters") or []
        if existing and all(item.get("image") for item in existing):
            return {"characters": existing}
        # 编剧节点已带角色卡时直接用；缺失（旧格式/解析失败）再单独抽取。
        characters = existing or []
        if not characters:
            await lifecycle("正在提取角色设定…")
            try:
                text, _usage, _model = await GATEWAY.complete(
                    preferred_model_id=preferred_model_id,
                    credentials=credentials,
                    messages=[
                        LlmMessage("system", _CHARACTER_SYSTEM),
                        LlmMessage("user", state["script"]),
                    ],
                    temperature=0.4,
                    timeout_seconds=90,
                    audit={"agentId": "media_agent", "agentRole": "comic_character_designer"},
                )
                payload = _extract_json_object(text)
                characters = _normalize_characters(payload.get("characters"))
            except Exception as exc:  # noqa: BLE001 - 角色抽取失败降级为无一致性出图。
                await lifecycle(f"角色提取失败，将按无参考图出图：{exc}")
                return {"characters": []}
        if not characters:
            return {"characters": []}

        output_dir = Path(state["output_dir"])
        provider = str(image_model_id).split(":", 1)[0] or "qwen"
        await lifecycle(f"正在准备 {len(characters)} 张角色设定图…")
        for index, character in enumerate(characters):
            if character.get("image"):
                continue
            # 先查角色设定图库：同描述同模型只生成一次，跨会话/跨集复用。
            content_hash = character_content_hash(
                appearance=str(character.get("appearance") or ""),
                outfit=str(character.get("outfit") or ""),
                model_id=image_model_id,
            )
            try:
                cached = await find_character_sheet(
                    content_hash=content_hash, model_id=image_model_id
                )
            except Exception as exc:  # noqa: BLE001 - 库不可用时照常生成。
                cached = None
                record_error = f"角色库查询失败，跳过复用：{exc}"
                await lifecycle(record_error)
            if cached is not None:
                data_url = read_asset_data_url(str(cached["filePath"]))
                if data_url:
                    character["image"] = {
                        "name": f"角色设定-{cached['name']}.png",
                        "downloadName": f"角色设定-{cached['name']}.png",
                        "type": "image/png",
                        "assetKind": "image",
                        "dataUrl": data_url,
                    }
                    await lifecycle(f"角色 {character.get('name')}：命中角色库，直接复用设定图")
                    continue

            sheet = await _generate_character_sheet(character, output_dir, index)
            character["image"] = sheet
            if sheet:
                data_url = str(
                    sheet.get("dataUrl") or sheet.get("data_url") or sheet.get("data") or ""
                )
                if data_url:
                    try:
                        await save_character_sheet(
                            name=str(character.get("name") or "未命名角色"),
                            appearance=str(character.get("appearance") or ""),
                            outfit=str(character.get("outfit") or ""),
                            model_id=image_model_id,
                            provider=provider,
                            prompt=str(sheet.get("prompt") or ""),
                            image_data_url=data_url,
                        )
                        await lifecycle(
                            f"角色 {character.get('name')}：设定图已入角色库（下次同描述直接复用）"
                        )
                    except Exception as exc:  # noqa: BLE001 - 入库失败不影响本次结果。
                        await lifecycle(f"角色 {character.get('name')}：设定图入库失败：{exc}")
        done = sum(1 for item in characters if item.get("image"))
        await lifecycle(f"角色设定图完成：{done}/{len(characters)}")
        return {"characters": characters}

    def after_design(state: ComicState) -> str:
        """人工确认通过后进入并行分镜，否则结束（等用户确认）。"""

        if not state.get("confirmed"):
            return END
        character_sheets = {
            item["name"]: item.get("image")
            for item in (state.get("characters") or [])
            if item.get("image")
        }
        return [
            Send(
                "process_shot",
                {
                    "shot": shot,
                    "output_dir": state["output_dir"],
                    "seed_base": 1000 + int(shot.get("index") or 1),
                    "semaphore": semaphore,
                    "character_sheets": character_sheets,
                },
            )
            for shot in state["storyboard"]
        ]

    async def process_shot(payload: dict[str, Any]) -> dict[str, Any]:
        """单镜：带角色参考出首帧 → 图生视频 → TTS → 下载本地（失败各重试）。"""

        shot: dict[str, Any] = payload["shot"]
        output_dir = Path(payload["output_dir"])
        seed = int(payload["seed_base"] or 1001)
        semaphore = payload["semaphore"]
        character_sheets: dict[str, dict[str, Any]] = payload.get("character_sheets") or {}
        index = int(shot.get("index") or 1)
        record: ComicShot = {
            "index": index,
            "title": shot.get("title", ""),
            "shot_type": shot.get("shot_type", ""),
            "image_prompt": shot.get("image_prompt", ""),
            "video_prompt": shot.get("video_prompt", ""),
            "negative_prompt": shot.get("negative_prompt", ""),
            "dialogue": shot.get("dialogue", ""),
            "duration": int(shot.get("duration") or 5),
            "characters": list(shot.get("characters") or []),
            "image": None,
            "video": None,
            "video_file": None,
            "audio_file": None,
            "status": "pending",
            "error": "",
        }
        image_api_key, image_api_base = _media_provider_context(image_model_id, credentials)
        if not image_api_key:
            record["status"] = "failed"
            record["error"] = (
                f"出图模型 {image_model_id} 需要 {image_model_id.split(':', 1)[0]} "
                "供应商的 API Key，请在设置里填写"
            )
            return {"shots": [record]}
        video_api_key, video_api_base = _media_provider_context(video_model_id, credentials)
        if not video_api_key:
            record["status"] = "failed"
            record["error"] = (
                f"视频模型 {video_model_id} 需要 {video_model_id.split(':', 1)[0]} "
                "供应商的 API Key，请在设置里填写"
            )
            return {"shots": [record]}

        await lifecycle(f"分镜 {index}：生成画面…")
        image_attachment: dict[str, Any] | None = None
        # 一致性：分镜角色命中设定图时走 image-edit（参考图约束外观）。
        refs = [
            character_sheets[name] for name in record["characters"] if name in character_sheets
        ][:2]
        image_mode = "image-edit" if refs else "text-to-image"
        if image_mode == "image-edit":
            # 所选出图模型不支持改图模式时回退纯文生图（一致性降级但不阻断）。
            try:
                from backend.services.media.catalog import get_media_model

                if "image-edit" not in (get_media_model(image_model_id).get("modes") or []):
                    image_mode = "text-to-image"
            except ValueError:
                image_mode = "text-to-image"
        for attempt in range(2):
            try:
                async with semaphore:
                    await throttle_media_request()
                    image_result = await generate_media(
                        MediaGenerateBody(
                            model_id=image_model_id,
                            mode=image_mode,
                            prompt=(
                                f"{shot.get('image_prompt', '')}（{shot.get('shot_type', '中景')}）"
                                + ("。角色外貌与服装严格保持参考图一致" if refs else "")
                            ),
                            negative_prompt=(
                                f"{shot.get('negative_prompt', '')}，{_NORMAL_NEGATIVE}"
                            ),
                            seed=seed + attempt,
                            size=IMAGE_SIZE,
                            attachments=refs,
                        ),
                        image_api_key,
                        image_api_base,
                    )
                attachments = image_result.get("attachments") or []
                if attachments:
                    image_attachment = attachments[0]
                    break
            except Exception as exc:  # noqa: BLE001
                record["error"] = f"出图失败：{exc}"
                await asyncio.sleep(10 + attempt * 10 if "429" in str(exc) else 2 + attempt * 2)
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
                            duration=record["duration"],
                            resolution=VIDEO_RESOLUTION,
                            ratio=VIDEO_RATIO,
                            attachment=image_attachment,
                        ),
                        video_api_key,
                        video_api_base,
                    )
                attachments = video_result.get("attachments") or []
                if attachments:
                    video_attachment = attachments[0]
                    break
            except Exception as exc:  # noqa: BLE001
                record["error"] = f"视频生成失败：{exc}"
                await asyncio.sleep(10 + attempt * 10 if "429" in str(exc) else 2 + attempt * 2)
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

        # 台词 TTS：失败降级为无声（字幕仍会生成）。
        dialogue = record["dialogue"]
        if dialogue:
            # qwen-tts 是百炼语音服务：固定用 qwen 供应商的用户 Key。
            tts_key = credentials.get("qwen") or ""
            audio_path = await synthesize_dialogue(
                dialogue,
                tts_key,
                output_dir / f"shot_{index:02d}.wav",
            )
            if audio_path:
                record["audio_file"] = audio_path.as_posix()
                await lifecycle(f"分镜 {index}：台词配音完成")
            else:
                await lifecycle(f"分镜 {index}：配音不可用，仅生成字幕")
        await lifecycle(f"分镜 {index}：完成", status="running")
        return {"shots": [record]}

    async def merge_node(state: ComicState) -> dict[str, Any]:
        """把成功分镜合成完整一集（音轨 + 字幕 + 可选 BGM）。"""

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
        output_dir = Path(state["output_dir"])
        srt_path = output_dir / "episode.srt"
        srt_path.write_text(build_srt([dict(shot) for shot in ordered]), encoding="utf-8")
        audios = [shot.get("audio_file") for shot in ordered]
        await lifecycle(f"正在合成 {len(videos)} 个分镜（音轨/字幕/BGM）…")

        def progress(current: int, total: int) -> None:
            """异步推送分镜合并进度事件（当前/总数）。"""

            asyncio.create_task(lifecycle(f"合并进度 {current}/{total}"))

        try:
            merged = await merge_video_episode(
                videos,
                str(output_dir / "episode.mp4"),
                audio_paths=audios,
                srt_path=srt_path.as_posix(),
                bgm_path=BGM_PATH or None,
                on_progress=progress,
            )
            report: dict[str, Any] = {
                "mergedPath": str(merged.get("outputPath") or ""),
                "ttsOk": int(merged.get("audioClips") or 0),
                "subtitleBurned": bool(merged.get("subtitleBurned")),
            }
            return {"report": report, "merged_path": report["mergedPath"]}
        except Exception as exc:  # noqa: BLE001
            # 音视频合成失败时退回纯视频拼接，保住产物。
            await lifecycle(f"音视频合成失败，回退纯视频拼接：{exc}")
            try:
                merged = await merge_videos(
                    videos, str(output_dir / "episode.mp4"), on_progress=progress
                )
                return {
                    "report": {
                        "mergedPath": str(merged.get("outputPath") or ""),
                        "ttsOk": 0,
                        "subtitleBurned": False,
                    },
                    "merged_path": str(merged.get("outputPath") or ""),
                }
            except Exception as fallback_exc:  # noqa: BLE001
                return {
                    "report": {
                        "passed": False,
                        "merged": False,
                        "reason": f"合并失败：{fallback_exc}",
                    }
                }

    async def quality_node(state: ComicState) -> dict[str, Any]:
        """质检：产物存在 + 分镜全部成功 + 配音/字幕状态。"""

        shots = state.get("shots") or []
        failed = [shot for shot in shots if shot.get("status") != "succeeded"]
        merged_path = state.get("merged_path")
        merged_ok = bool(merged_path and Path(merged_path).is_file())
        report: dict[str, Any] = {
            "passed": merged_ok and not failed,
            "merged": merged_ok,
            "shotTotal": len(shots),
            "shotFailed": len(failed),
            "mergedPath": merged_path,
            "ttsOk": sum(1 for shot in shots if shot.get("audio_file")),
            "subtitleBurned": bool((state.get("report") or {}).get("subtitleBurned")),
        }
        if failed:
            report["reason"] = "；".join(f"分镜{s.get('index')}：{s.get('error')}" for s in failed)[
                :2000
            ]
        return {"report": report}

    graph = StateGraph(ComicState)
    graph.add_node("writer", writer_node)
    graph.add_node("character_design", character_design_node)
    graph.add_node("process_shot", process_shot)
    graph.add_node("merge", merge_node)
    graph.add_node("quality", quality_node)
    graph.add_edge(START, "writer")
    graph.add_edge("writer", "character_design")
    graph.add_conditional_edges("character_design", after_design, ["process_shot", END])
    graph.add_edge("process_shot", "merge")
    graph.add_edge("merge", "quality")
    graph.add_edge("quality", END)
    return graph.compile()


__all__ = [
    "ComicState",
    "build_comic_pipeline",
]
