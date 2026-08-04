"""火山引擎（豆包）媒体生成客户端。

图片：``POST {base}/images/generations``（同步返回 URL / base64）；
视频：``POST {base}/videos/generations``（异步任务）→ 轮询
``GET {base}/videos/generations/{id}`` 直到成功并下载成片。
未配置 ``DOUBAO_BASE_URL`` 时默认使用方舟公网地址。
"""

from __future__ import annotations

import asyncio
import base64
import mimetypes
import time
from typing import Any

import httpx

from backend.schemas.media import MediaGenerateBody

DEFAULT_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3"
VIDEO_POLL_INTERVAL_SECONDS = 5.0
VIDEO_POLL_TIMEOUT_SECONDS = 600.0
DEFAULT_TIMEOUT = httpx.Timeout(120.0, connect=15.0)


def resolve_volcengine_base(explicit: str | None) -> str:
    """返回火山引擎方舟 API 根地址，未配置时使用公网默认值。"""

    value = (explicit or "").strip().rstrip("/")
    return value or DEFAULT_BASE_URL


async def _read_json(response: httpx.Response) -> dict[str, Any]:
    """读取 JSON 响应，并把供应商错误转换成中文异常。"""

    try:
        payload = response.json()
    except ValueError:
        payload = {"message": response.text[:800]}
    if response.status_code >= 400:
        error = payload.get("error") or payload.get("message") or "未知错误"
        if isinstance(error, dict):
            error = str(error)
        raise ValueError(f"火山引擎请求失败（HTTP {response.status_code}）：{error}")
    return payload if isinstance(payload, dict) else {}


def _extract_image_urls(payload: dict[str, Any]) -> list[str]:
    """从方舟图片响应中提取 URL 或 base64 数据。"""

    urls: list[str] = []
    for item in payload.get("data") or []:
        if not isinstance(item, dict):
            continue
        if item.get("url"):
            urls.append(str(item["url"]))
        elif item.get("b64_json"):
            urls.append(f"data:image/png;base64,{item['b64_json']}")
    return urls


def _extract_video_url(payload: dict[str, Any]) -> str:
    """兼容不同版本的方舟视频响应结构。"""

    content = payload.get("content")
    if isinstance(content, dict) and content.get("video_url"):
        return str(content["video_url"])
    if isinstance(content, str) and content:
        return content
    data = payload.get("data") or []
    if data and isinstance(data[0], dict):
        for key in ("url", "video_url", "download_url"):
            if data[0].get(key):
                return str(data[0][key])
    output = payload.get("output") or {}
    if isinstance(output, dict):
        for key in ("video_url", "url"):
            if output.get(key):
                return str(output[key])
        videos = output.get("videos") or []
        if videos and isinstance(videos[0], dict) and videos[0].get("url"):
            return str(videos[0]["url"])
    return ""


async def _download(
    client: httpx.AsyncClient,
    url: str,
    index: int,
    kind: str,
) -> dict[str, Any]:
    """下载生成媒体并转换成可长期保存的 Data URL。"""

    response = await client.get(url)
    response.raise_for_status()
    mime_type = response.headers.get(
        "content-type",
        "video/mp4" if kind == "video" else "image/png",
    ).split(";", 1)[0]
    extension = mimetypes.guess_extension(mime_type) or (
        ".mp4" if kind == "video" else ".png"
    )
    file_name = f"doubao-{kind}-{int(time.time() * 1000)}-{index + 1}{extension}"
    data_url = f"data:{mime_type};base64,{base64.b64encode(response.content).decode()}"
    return {
        "name": file_name,
        "downloadName": file_name,
        "type": mime_type,
        "assetKind": kind,
        "dataUrl": data_url,
        "url": url,
    }


async def generate_volcengine_image(
    body: MediaGenerateBody,
    api_key: str,
    api_base: str | None = None,
) -> dict[str, Any]:
    """调用方舟文生图接口并返回统一附件结构。"""

    base = resolve_volcengine_base(api_base)
    prompt = body.prompt.strip()
    if not prompt:
        raise ValueError("媒体生成提示词不能为空")
    size = (body.size or "1024*1024").replace("*", "x")
    parameters: dict[str, Any] = {
        "model": str(body.model_id).split(":", 1)[-1],
        "prompt": prompt,
        "size": size,
        "response_format": "url",
    }
    if body.seed is not None:
        parameters["seed"] = int(body.seed)
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        response = await client.post(
            f"{base}/images/generations",
            json=parameters,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )
        payload = await _read_json(response)
        urls = _extract_image_urls(payload)
        if not urls:
            raise ValueError("火山引擎图片响应中没有图片地址")
        attachments: list[dict[str, Any]] = []
        for index, url in enumerate(urls):
            if url.startswith("data:"):
                mime_type = url.split(";", 1)[0].split(":", 1)[-1]
                file_name = f"doubao-image-{int(time.time() * 1000)}-{index + 1}.png"
                attachments.append(
                    {
                        "name": file_name,
                        "downloadName": file_name,
                        "type": mime_type,
                        "assetKind": "image",
                        "dataUrl": url,
                        "url": url,
                    }
                )
            else:
                attachments.append(await _download(client, url, index, "image"))
    return {
        "content": "已使用豆包图像模型完成生成。",
        "attachments": attachments,
        "usage": {
            "prompt": 0,
            "completion": 0,
            "total": len(attachments),
        },
    }


async def generate_volcengine_video(
    body: MediaGenerateBody,
    api_key: str,
    api_base: str | None = None,
) -> dict[str, Any]:
    """调用方舟文生视频接口，轮询任务并下载成片。"""

    base = resolve_volcengine_base(api_base)
    prompt = body.prompt.strip()
    if not prompt:
        raise ValueError("媒体生成提示词不能为空")
    model = str(body.model_id).split(":", 1)[-1]
    async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT) as client:
        response = await client.post(
            f"{base}/videos/generations",
            json={
                "model": model,
                "content": [{"type": "text", "text": prompt}],
            },
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )
        payload = await _read_json(response)
        task_id = str(
            payload.get("id")
            or ((payload.get("output") or {}).get("id"))
            or ""
        )
        if not task_id:
            raise ValueError("火山引擎视频响应中没有任务 ID")

        deadline = time.monotonic() + VIDEO_POLL_TIMEOUT_SECONDS
        video_url = ""
        while time.monotonic() < deadline:
            await asyncio.sleep(VIDEO_POLL_INTERVAL_SECONDS)
            poll = await client.get(
                f"{base}/videos/generations/{task_id}",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            state = await _read_json(poll)
            status = str(state.get("status") or "").lower()
            if status in {"success", "succeeded", "completed", "done"}:
                video_url = _extract_video_url(state)
                break
            if status in {"failed", "error", "cancelled", "canceled"}:
                error = state.get("error") or state.get("message") or "未知原因"
                raise ValueError(f"火山引擎视频生成失败：{error}")
        if not video_url:
            raise ValueError("火山引擎视频生成超时")
        attachments = [await _download(client, video_url, 0, "video")]
    return {
        "content": "已使用豆包视频模型完成生成。临时地址通常只保留一段时间，请及时下载。",
        "attachments": attachments,
        "usage": {
            "prompt": 0,
            "completion": 0,
            "total": 1,
            "unit": "videos",
            "label": "视频额度",
        },
    }


__all__ = [
    "DEFAULT_BASE_URL",
    "generate_volcengine_image",
    "generate_volcengine_video",
    "resolve_volcengine_base",
]
