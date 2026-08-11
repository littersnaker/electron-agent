"""DashScope 图片与视频生成客户端。"""

from __future__ import annotations

import asyncio
import base64
import mimetypes
import os
import re
import time
from typing import Any

import httpx

from backend.core.builtin_credentials import get_builtin_value
from backend.core.config import get_settings
from backend.schemas.common import FrontendAttachment
from backend.schemas.media import MediaGenerateBody
from backend.services.media.catalog import get_media_model

DEFAULT_API_BASE = "https://dashscope.aliyuncs.com"
IMAGE_PATH = "/api/v1/services/aigc/multimodal-generation/generation"
VIDEO_PATH = "/api/v1/services/aigc/video-generation/video-synthesis"


def resolve_media_api_base(explicit_base_url: str | None = None) -> str:
    """解析图片和视频实际使用的 DashScope 根域名。

    优先级为：设置页请求头、自定义媒体环境变量、旧版环境变量、聊天 Base URL、
    构建期内置值、公共域名。即使用户粘贴了 ``/compatible-mode/v1`` 或完整
    图片/视频接口，本函数也会提取同一个业务空间根域名。
    """

    candidates = (
        explicit_base_url or "",
        os.getenv("DASHSCOPE_MEDIA_BASE_URL", ""),
        os.getenv("DASHSCOPE_API_BASE", ""),
        os.getenv("DASHSCOPE_BASE_URL", ""),
        get_builtin_value("DASHSCOPE_MEDIA_BASE_URL"),
        get_builtin_value("DASHSCOPE_BASE_URL"),
        DEFAULT_API_BASE,
    )
    raw = next((item.strip() for item in candidates if item and item.strip()), DEFAULT_API_BASE)
    normalized = raw.rstrip("/")
    for marker in ("/compatible-mode/", "/api/v1/"):
        marker_index = normalized.find(marker)
        if marker_index >= 0:
            normalized = normalized[:marker_index]
            break
    return normalized.rstrip("/")


def _attachment_data_url(attachment: FrontendAttachment) -> str:
    """把附件转换成完整 Data URL。"""

    if attachment.data_url and attachment.data_url.startswith("data:"):
        return attachment.data_url
    data = re.sub(r"\s+", "", attachment.data or "")
    if not data:
        raise ValueError(f"附件 {attachment.name} 缺少数据")
    return f"data:{attachment.mime_type};base64,{data}"


def _build_prompt(body: MediaGenerateBody) -> str:
    """根据文字策略和改图保真度补充简洁约束。"""

    prompt = body.prompt.strip()
    if not prompt:
        raise ValueError("媒体生成提示词不能为空")
    suffixes: list[str] = []
    if body.typography_policy == "avoid-generated-text":
        suffixes.append("画面中不要生成任何文字、字幕、Logo 或水印。")
    elif body.typography_policy == "strict-short-text":
        suffixes.append("如需文字，只生成用户明确给出的短文字，确保清晰准确。")
    if body.mode == "image-edit":
        fidelity = {
            "precise": "只修改用户指定区域，严格保留其他结构、主体数量和构图。",
            "balanced": "保留主要结构，仅在完成指令所需范围内重绘。",
            "creative": "允许在保持主题的前提下进行创意重构。",
        }.get(body.image_edit_fidelity, "")
        if fidelity:
            suffixes.append(fidelity)
    return "\n".join([prompt, *suffixes])


def _extract_image_urls(payload: dict[str, Any]) -> list[str]:
    """从 DashScope 多模态响应中提取图片地址。"""

    choices = ((payload.get("output") or {}).get("choices") or [])
    urls: list[str] = []
    for choice in choices:
        content = (((choice or {}).get("message") or {}).get("content") or [])
        for item in content:
            value = (item or {}).get("image")
            if isinstance(value, str) and value:
                urls.append(value)
    return urls


async def _read_json(response: httpx.Response) -> dict[str, Any]:
    """读取 JSON 响应，并把供应商错误转换成中文异常。"""

    try:
        payload = response.json()
    except ValueError:
        payload = {"message": response.text[:800]}
    if response.status_code >= 400:
        message = payload.get("message") or payload.get("code") or "未知错误"
        raise ValueError(f"百炼请求失败（HTTP {response.status_code}）：{message}")
    return payload if isinstance(payload, dict) else {}


async def _download_image(client: httpx.AsyncClient, url: str, index: int) -> dict[str, Any]:
    """下载生成图片并转换成可长期保存的 Data URL。"""

    response = await client.get(url)
    response.raise_for_status()
    mime_type = response.headers.get("content-type", "image/png").split(";", 1)[0]
    extension = mimetypes.guess_extension(mime_type) or ".png"
    file_name = f"qwen-image-{int(time.time() * 1000)}-{index + 1}{extension}"
    data_url = f"data:{mime_type};base64,{base64.b64encode(response.content).decode()}"
    return {
        "name": file_name,
        "downloadName": file_name,
        "type": mime_type,
        "assetKind": "image",
        "dataUrl": data_url,
        "url": url,
    }


async def generate_image(
    body: MediaGenerateBody,
    api_key: str,
    api_base: str,
) -> dict[str, Any]:
    """执行文生图或图片编辑请求。"""

    model = get_media_model(body.model_id)
    if body.mode not in model["modes"]:
        raise ValueError(f"{model['name']} 不支持 {body.mode} 模式")
    attachment = body.attachment or (body.attachments[0] if body.attachments else None)
    if body.mode == "image-edit" and not attachment:
        raise ValueError("图片编辑模式必须先上传一张图片")

    content: list[dict[str, str]] = []
    if attachment:
        content.append({"image": _attachment_data_url(attachment)})
    content.append({"text": _build_prompt(body)})
    base_negative = "乱码，伪文字，文字扭曲，重复主体，重影，双重曝光，低画质"
    parameters: dict[str, Any] = {
        "n": 1,
        "negative_prompt": (
            f"{base_negative}，{body.negative_prompt}"
            if body.negative_prompt
            else base_negative
        ),
        "prompt_extend": body.image_edit_fidelity != "precise",
        "watermark": False,
    }
    if body.seed is not None:
        parameters["seed"] = int(body.seed)
    if body.size:
        parameters["size"] = body.size
    elif body.mode == "text-to-image":
        parameters["size"] = "2048*2048"

    timeout = httpx.Timeout(get_settings().request_timeout_seconds, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        response = await client.post(
            f"{api_base}{IMAGE_PATH}",
            headers={"Authorization": f"Bearer {api_key}"},
            json={
                "model": model["model"],
                "input": {"messages": [{"role": "user", "content": content}]},
                "parameters": parameters,
            },
        )
        payload = await _read_json(response)
        urls = _extract_image_urls(payload)
        if not urls:
            raise ValueError("图片任务完成，但响应中没有图片地址")
        attachments = [
            await _download_image(client, url, index) for index, url in enumerate(urls)
        ]

    image_count = int((payload.get("usage") or {}).get("image_count") or len(attachments))
    return {
        "content": f"已使用 {model['name']} 完成图片生成。",
        "attachments": attachments,
        "usage": {
            "prompt": 0,
            "completion": 0,
            "total": image_count,
            "unit": "images",
            "label": "图片额度",
        },
        "quality": {
            "checked": False,
            "passed": True,
            "retried": False,
            "ghostingDetected": False,
            "unrelatedChangesDetected": False,
        },
    }


async def _upload_video(
    client: httpx.AsyncClient,
    attachment: FrontendAttachment,
    model_name: str,
    api_key: str,
    api_base: str,
) -> str:
    """把视频附件上传到 DashScope 临时 OSS，并返回 ``oss://`` 地址。"""

    policy_response = await client.get(
        f"{api_base}/api/v1/uploads",
        params={"action": "getPolicy", "model": model_name},
        headers={"Authorization": f"Bearer {api_key}"},
    )
    policy_payload = await _read_json(policy_response)
    policy = policy_payload.get("data") or {}
    required = [
        "policy",
        "signature",
        "upload_dir",
        "upload_host",
        "oss_access_key_id",
        "x_oss_object_acl",
        "x_oss_forbid_overwrite",
    ]
    if not all(policy.get(key) for key in required):
        raise ValueError("百炼临时文件上传凭证不完整")

    raw = attachment.data or ""
    if attachment.data_url and "," in attachment.data_url:
        raw = attachment.data_url.split(",", 1)[1]
    try:
        binary = base64.b64decode(re.sub(r"\s+", "", raw), validate=True)
    except ValueError as exc:
        raise ValueError("视频附件 Base64 数据无效") from exc

    safe_name = re.sub(r"[^\w.\-]+", "_", attachment.name)[-120:] or "video.mp4"
    object_key = f"{policy['upload_dir']}/{safe_name}"
    form = {
        "OSSAccessKeyId": policy["oss_access_key_id"],
        "policy": policy["policy"],
        "Signature": policy["signature"],
        "key": object_key,
        "x-oss-object-acl": policy["x_oss_object_acl"],
        "x-oss-forbid-overwrite": policy["x_oss_forbid_overwrite"],
        "success_action_status": "200",
    }
    upload = await client.post(
        policy["upload_host"],
        data=form,
        files={"file": (safe_name, binary, attachment.mime_type)},
    )
    if upload.status_code >= 400:
        raise ValueError(f"上传视频到百炼临时空间失败（HTTP {upload.status_code}）")
    return f"oss://{object_key}"


async def _build_video_input(
    body: MediaGenerateBody,
    model_name: str,
    api_key: str,
    client: httpx.AsyncClient,
    api_base: str,
) -> dict[str, Any]:
    """根据视频模式构建 DashScope ``input``。"""

    attachment = body.attachment or (body.attachments[0] if body.attachments else None)
    prompt = body.prompt.strip()
    if body.mode == "text-to-video":
        return {"prompt": prompt}
    if not attachment:
        raise ValueError("当前视频模式必须先上传素材")
    if body.mode == "image-to-video":
        return {"prompt": prompt, "media": [{"type": "first_frame", "url": _attachment_data_url(attachment)}]}
    if body.mode == "reference-to-video":
        return {"prompt": prompt, "media": [{"type": "reference_image", "url": _attachment_data_url(attachment)}]}
    if body.mode == "video-edit":
        temporary_url = await _upload_video(
            client, attachment, model_name, api_key, api_base
        )
        return {"prompt": prompt, "media": [{"type": "video", "url": temporary_url}]}
    raise ValueError(f"不支持的视频模式：{body.mode}")


async def generate_video(
    body: MediaGenerateBody,
    api_key: str,
    api_base: str,
) -> dict[str, Any]:
    """提交视频任务、轮询结果并返回临时视频地址。"""

    model = get_media_model(body.model_id)
    if body.mode not in model["modes"]:
        raise ValueError(f"{model['name']} 不支持 {body.mode} 模式")
    timeout = httpx.Timeout(420.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        input_payload = await _build_video_input(
            body, str(model["model"]), api_key, client, api_base
        )
        parameters: dict[str, Any]
        if body.mode == "video-edit":
            parameters = {"resolution": "720P", "watermark": False, "audio_setting": "auto"}
        else:
            parameters = {"resolution": "720P", "ratio": "16:9", "duration": 5, "watermark": False}
            if "happyhorse" not in body.model_id:
                parameters["prompt_extend"] = True
        if body.seed is not None:
            parameters["seed"] = int(body.seed)

        response = await client.post(
            f"{api_base}{VIDEO_PATH}",
            headers={
                "Authorization": f"Bearer {api_key}",
                "X-DashScope-Async": "enable",
                "X-DashScope-OssResourceResolve": "enable",
            },
            json={"model": model["model"], "input": input_payload, "parameters": parameters},
        )
        submitted = await _read_json(response)
        task_id = ((submitted.get("output") or {}).get("task_id"))
        if not task_id:
            raise ValueError("视频任务提交成功，但没有返回 task_id")

        deadline = time.monotonic() + 360
        video_url = ""
        while time.monotonic() < deadline:
            await asyncio.sleep(5)
            result_response = await client.get(
                f"{api_base}/api/v1/tasks/{task_id}",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            result = await _read_json(result_response)
            output = result.get("output") or {}
            status = str(output.get("task_status") or "").upper()
            if status == "SUCCEEDED":
                video_url = str(output.get("video_url") or "")
                if not video_url:
                    for item in output.get("results") or []:
                        video_url = str((item or {}).get("video_url") or (item or {}).get("url") or "")
                        if video_url:
                            break
                break
            if status in {"FAILED", "CANCELED", "UNKNOWN"}:
                raise ValueError(result.get("message") or f"视频任务结束，状态：{status}")
        if not video_url:
            raise ValueError("等待视频生成超时，任务可能仍在百炼后台运行")

    file_name = f"dashscope-video-{int(time.time() * 1000)}.mp4"
    return {
        "content": f"已使用 {model['name']} 完成视频生成。临时地址通常只保留 24 小时，请及时下载。",
        "attachments": [
            {
                "name": file_name,
                "downloadName": file_name,
                "type": "video/mp4",
                "assetKind": "video",
                "url": video_url,
            }
        ],
        "usage": {
            "prompt": 0,
            "completion": 0,
            "total": 1,
            "unit": "videos",
            "label": "视频额度",
        },
    }


async def generate_media(
    body: MediaGenerateBody,
    api_key: str,
    explicit_base_url: str | None = None,
) -> dict[str, Any]:
    """根据模型协议把请求分发到图片或视频流程。"""

    model = get_media_model(body.model_id)
    api_base = resolve_media_api_base(explicit_base_url)
    if model["protocol"] == "qwen-image-sync":
        return await generate_image(body, api_key, api_base)
    if model["protocol"] == "volcengine-image":
        from backend.services.media.volcengine import generate_volcengine_image

        return await generate_volcengine_image(body, api_key, api_base)
    if model["protocol"] == "volcengine-video-async":
        from backend.services.media.volcengine import generate_volcengine_video

        return await generate_volcengine_video(body, api_key, api_base)
    return await generate_video(body, api_key, api_base)
