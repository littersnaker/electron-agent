"""漫剧音频与字幕：台词 TTS、SRT 时间轴与 ffmpeg 能力探测。

TTS 走百炼 qwen-tts HTTP 接口（复用 DASHSCOPE_API_KEY），任何失败都返回
None 由调用方降级为「只出字幕不配音」，绝不阻断漫剧主流程。
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

import httpx

from backend.services.media.dashscope import resolve_media_api_base

LOGGER = logging.getLogger(__name__)

TTS_MODEL = os.getenv("MEDIA_TTS_MODEL", "qwen-tts")
TTS_VOICE = os.getenv("MEDIA_TTS_VOICE", "Cherry")
TTS_TIMEOUT_SECONDS = 60.0


def _first_audio_url(payload: Any) -> str:
    """在任意层级的响应里找第一个 http 音频地址（兼容响应结构变动）。"""

    if isinstance(payload, str):
        return payload if payload.startswith("http") else ""
    if isinstance(payload, dict):
        for key in ("url", "audio", "output"):
            if key in payload:
                found = _first_audio_url(payload[key])
                if found:
                    return found
        for value in payload.values():
            found = _first_audio_url(value)
            if found:
                return found
    if isinstance(payload, list):
        for item in payload:
            found = _first_audio_url(item)
            if found:
                return found
    return ""


async def synthesize_dialogue(
    text: str,
    api_key: str,
    output_path: Path,
    *,
    api_base: str | None = None,
) -> Path | None:
    """把一段台词合成为音频文件；失败返回 None（调用方降级为无声）。"""

    clean = " ".join(text.split()).strip()
    if not clean:
        return None
    base = resolve_media_api_base(api_base)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(TTS_TIMEOUT_SECONDS)) as client:
            response = await client.post(
                f"{base}/api/v1/services/audio/tts",
                headers={"Authorization": f"Bearer {api_key}"},
                json={
                    "model": TTS_MODEL,
                    "input": {"text": clean[:1200]},
                    "parameters": {"voice": TTS_VOICE, "format": "wav"},
                },
            )
            if response.status_code >= 400:
                LOGGER.warning(
                    "TTS 请求失败（HTTP %s）：%s", response.status_code, response.text[:200]
                )
                return None
            payload = response.json()
        audio_url = _first_audio_url(payload)
        if not audio_url:
            LOGGER.warning("TTS 响应中没有音频地址：%s", json.dumps(payload)[:200])
            return None
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0), follow_redirects=True) as client:
            audio = await client.get(audio_url)
            audio.raise_for_status()
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(audio.content)
        return output_path
    except Exception as exc:  # noqa: BLE001 - TTS 是增强能力，失败必须降级。
        LOGGER.warning("TTS 合成异常：%s", exc)
        return None


def _srt_timestamp(seconds: float) -> str:
    """把秒数格式化为 SRT 时间码 HH:MM:SS,mmm。"""

    total_millis = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(total_millis, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def build_srt(shots: list[dict[str, Any]]) -> str:
    """按分镜顺序与时长累计生成整集 SRT 字幕文本。"""

    entries: list[str] = []
    cursor = 0.0
    index = 0
    for shot in shots:
        dialogue = str(shot.get("dialogue") or "").strip()
        duration = max(1.0, float(shot.get("duration") or 5))
        if dialogue:
            index += 1
            entries.append(
                f"{index}\n{_srt_timestamp(cursor)} --> {_srt_timestamp(cursor + duration)}\n"
                f"{dialogue}\n"
            )
        cursor += duration
    return "\n".join(entries)
