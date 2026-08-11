"""调用智谱 GLM-4.6V-Flash 的轻量异步客户端。

本模块只负责视觉预分析，不改变项目现有 LLM Gateway。API Key 优先读取当前请求中
已配置的 ``glm`` 凭证，其次读取环境变量，确保 Code Agent 与 QA Agent 可以复用
设置界面中的智谱 Key。
"""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import os
from dataclasses import dataclass
from typing import Any, Protocol

import httpx

DEFAULT_BASE_URL = "https://open.bigmodel.cn/api/paas/v4"
DEFAULT_MODEL = "glm-4.6v-flash"
DEFAULT_TIMEOUT_SECONDS = 180.0
DEFAULT_MAX_IMAGES = 8
DEFAULT_MAX_IMAGE_MB = 20.0
DEFAULT_MAX_TOTAL_MB = 40.0
RETRYABLE_STATUS_CODES = {408, 409, 429, 500, 502, 503, 504}


class CredentialsLike(Protocol):
    """项目 LLMCredentials 在本模块中使用的最小接口。"""

    def get(self, provider: str) -> str: ...

    def get_endpoint(self, provider: str) -> str: ...


class GLM46VError(RuntimeError):
    """GLM 视觉预分析失败。"""


@dataclass(frozen=True, slots=True)
class ImageInput:
    """一次视觉请求中的规范化图片。"""

    name: str
    mime_type: str
    data: str
    size_bytes: int


@dataclass(frozen=True, slots=True)
class GLM46VSettings:
    """GLM-4.6V-Flash 请求配置。"""

    api_key: str
    endpoint: str
    model: str = DEFAULT_MODEL
    timeout_seconds: float = DEFAULT_TIMEOUT_SECONDS
    retries: int = 2
    max_images: int = DEFAULT_MAX_IMAGES
    max_image_mb: float = DEFAULT_MAX_IMAGE_MB
    max_total_mb: float = DEFAULT_MAX_TOTAL_MB

    @classmethod
    def from_credentials(cls, credentials: object | None) -> GLM46VSettings:
        """从当前请求凭证与环境变量构建设置，且不记录密钥。"""

        request_key = _credential_value(credentials, "get", "glm")
        api_key = (
            request_key
            or os.getenv("ZHIPU_API_KEY", "").strip()
            or os.getenv("GLM_API_KEY", "").strip()
        )
        request_base = _credential_value(credentials, "get_endpoint", "glm")
        configured_endpoint = (
            os.getenv("GLM46V_API_ENDPOINT", "").strip()
            or request_base
            or os.getenv("GLM_BASE_URL", "").strip()
            or DEFAULT_BASE_URL
        )
        return cls(
            api_key=api_key,
            endpoint=normalize_chat_endpoint(configured_endpoint),
            model=os.getenv("GLM46V_MODEL", DEFAULT_MODEL).strip() or DEFAULT_MODEL,
            timeout_seconds=_env_float(
                "GLM46V_TIMEOUT_SECONDS",
                DEFAULT_TIMEOUT_SECONDS,
                minimum=5.0,
                maximum=600.0,
            ),
            retries=_env_int("GLM46V_RETRIES", 2, minimum=0, maximum=6),
            max_images=_env_int(
                "GLM46V_MAX_IMAGES",
                DEFAULT_MAX_IMAGES,
                minimum=1,
                maximum=20,
            ),
            max_image_mb=_env_float(
                "GLM46V_MAX_IMAGE_MB",
                DEFAULT_MAX_IMAGE_MB,
                minimum=0.1,
                maximum=100.0,
            ),
            max_total_mb=_env_float(
                "GLM46V_MAX_TOTAL_MB",
                DEFAULT_MAX_TOTAL_MB,
                minimum=0.1,
                maximum=200.0,
            ),
        )


def _credential_value(credentials: object | None, method_name: str, key: str) -> str:
    if credentials is None:
        return ""
    method = getattr(credentials, method_name, None)
    if not callable(method):
        return ""
    try:
        value = method(key)
    except (KeyError, TypeError, ValueError):
        return ""
    return str(value or "").strip()


def _env_int(name: str, default: int, *, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError:
        return default
    return max(minimum, min(value, maximum))


def _env_float(
    name: str,
    default: float,
    *,
    minimum: float,
    maximum: float,
) -> float:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = float(raw)
    except ValueError:
        return default
    return max(minimum, min(value, maximum))


def normalize_chat_endpoint(value: str) -> str:
    """把用户填写的 Base URL 安全规范化为 Chat Completions 地址。"""

    endpoint = value.strip().rstrip("/") or DEFAULT_BASE_URL
    if endpoint.endswith("/chat/completions"):
        return endpoint
    return f"{endpoint}/chat/completions"


def _strip_data_url(value: str) -> tuple[str, str | None]:
    stripped = value.strip()
    if not stripped.startswith("data:"):
        return stripped, None
    header, separator, payload = stripped.partition(",")
    if not separator or ";base64" not in header.lower():
        raise GLM46VError("图片 Data URL 不是有效的 Base64 数据。")
    mime = header[5:].split(";", 1)[0].strip() or None
    return payload.strip(), mime


def normalize_image_data(
    *,
    name: str,
    mime_type: str,
    data: str,
    max_image_mb: float,
) -> ImageInput:
    """校验并规范化前端传来的 Base64 图片。"""

    raw, data_url_mime = _strip_data_url(data)
    compact = "".join(raw.split())
    if not compact:
        raise GLM46VError(f"图片 {name or 'attachment'} 没有有效数据。")
    try:
        decoded = base64.b64decode(compact, validate=True)
    except (ValueError, binascii.Error) as exc:
        raise GLM46VError(f"图片 {name or 'attachment'} 的 Base64 数据无效。") from exc

    resolved_mime = (data_url_mime or mime_type or "image/png").strip().lower()
    if not resolved_mime.startswith("image/"):
        raise GLM46VError(f"附件 {name or 'attachment'} 不是图片类型：{resolved_mime}")
    max_bytes = int(max_image_mb * 1024 * 1024)
    if len(decoded) > max_bytes:
        raise GLM46VError(
            f"图片 {name or 'attachment'} 大小为 {len(decoded) / 1024 / 1024:.2f} MB，"
            f"超过 {max_image_mb:.2f} MB 限制。"
        )
    return ImageInput(
        name=name.strip() or "attachment",
        mime_type=resolved_mime,
        data=compact,
        size_bytes=len(decoded),
    )


def _normalize_content(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if value is None:
        return ""
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if text:
                    parts.append(str(text))
        return "\n".join(parts).strip()
    return str(value).strip()


def _error_message(response: httpx.Response) -> str:
    try:
        payload = response.json()
    except ValueError:
        return response.text[:800] or response.reason_phrase
    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            return str(error.get("message") or error.get("code") or error)
        return str(payload.get("message") or payload.get("msg") or payload)
    return str(payload)


class GLM46VClient:
    """只用于视觉证据提取的 GLM-4.6V-Flash 客户端。"""

    def __init__(
        self,
        settings: GLM46VSettings,
        *,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.settings = settings
        self._transport = transport

    async def analyze_images(
        self,
        images: list[ImageInput],
        *,
        prompt: str,
        max_tokens: int = 6144,
    ) -> dict[str, Any]:
        """联合分析一组图片并返回规范化结果。"""

        if not self.settings.api_key:
            raise GLM46VError(
                "未配置智谱 GLM API Key。请在项目模型设置中填写“智谱 GLM”，"
                "或设置 ZHIPU_API_KEY。"
            )
        if not images:
            raise GLM46VError("视觉分析至少需要一张图片。")
        if len(images) > self.settings.max_images:
            raise GLM46VError(
                f"单次最多分析 {self.settings.max_images} 张图片，当前为 {len(images)} 张。"
            )
        total_bytes = sum(item.size_bytes for item in images)
        max_total_bytes = int(self.settings.max_total_mb * 1024 * 1024)
        if total_bytes > max_total_bytes:
            raise GLM46VError(
                f"图片总大小为 {total_bytes / 1024 / 1024:.2f} MB，"
                f"超过 {self.settings.max_total_mb:.2f} MB 限制。"
            )
        if not prompt.strip():
            raise GLM46VError("视觉分析 prompt 不能为空。")

        content: list[dict[str, Any]] = [
            {
                "type": "image_url",
                # GLM-4.6V 官方接口支持直接传入纯 Base64；不把密钥或本地路径写入请求。
                "image_url": {"url": image.data},
            }
            for image in images
        ]
        content.append({"type": "text", "text": prompt.strip()})
        payload = {
            "model": self.settings.model,
            "messages": [{"role": "user", "content": content}],
            "thinking": {"type": "enabled"},
            "temperature": 0.1,
            "max_tokens": max(512, min(int(max_tokens), 16_384)),
            "stream": False,
        }
        headers = {
            "Authorization": f"Bearer {self.settings.api_key}",
            "Content-Type": "application/json",
            "User-Agent": "next-agent-glm46v-vision/1.0",
        }
        timeout = httpx.Timeout(self.settings.timeout_seconds, connect=30.0)
        async with httpx.AsyncClient(
            timeout=timeout,
            transport=self._transport,
        ) as client:
            data, response_headers = await self._post_with_retries(
                client,
                payload=payload,
                headers=headers,
            )

        try:
            choice = data["choices"][0]
            message = choice["message"]
        except (KeyError, IndexError, TypeError) as exc:
            preview = json.dumps(data, ensure_ascii=False)[:800]
            raise GLM46VError(f"智谱 API 返回了无法解析的响应：{preview}") from exc

        result = {
            "model": str(data.get("model") or self.settings.model),
            "content": _normalize_content(message.get("content")),
            "finish_reason": choice.get("finish_reason"),
            "usage": data.get("usage") if isinstance(data.get("usage"), dict) else {},
            "request_id": data.get("id") or response_headers.get("x-request-id"),
        }
        if not result["content"]:
            raise GLM46VError("GLM-4.6V-Flash 没有返回可用的视觉分析文本。")
        return result

    async def _post_with_retries(
        self,
        client: httpx.AsyncClient,
        *,
        payload: dict[str, Any],
        headers: dict[str, str],
    ) -> tuple[dict[str, Any], httpx.Headers]:
        last_error: Exception | None = None
        for attempt in range(self.settings.retries + 1):
            try:
                response = await client.post(
                    self.settings.endpoint,
                    headers=headers,
                    json=payload,
                )
            except (httpx.TimeoutException, httpx.NetworkError) as exc:
                last_error = exc
                if attempt >= self.settings.retries:
                    raise GLM46VError(f"连接智谱 API 失败：{exc}") from exc
                await asyncio.sleep(min(2**attempt, 4))
                continue

            if response.status_code < 400:
                try:
                    return response.json(), response.headers
                except ValueError as exc:
                    raise GLM46VError(
                        f"智谱 API 返回了非 JSON 响应：{response.text[:500]}"
                    ) from exc

            message = _error_message(response)
            if (
                response.status_code in RETRYABLE_STATUS_CODES
                and attempt < self.settings.retries
            ):
                retry_after = response.headers.get("retry-after", "").strip()
                try:
                    delay = float(retry_after) if retry_after else min(2**attempt, 4)
                except ValueError:
                    delay = min(2**attempt, 4)
                await asyncio.sleep(max(0.0, min(delay, 10.0)))
                continue
            raise GLM46VError(
                f"智谱 API 请求失败（HTTP {response.status_code}）：{message}"
            )

        raise GLM46VError(f"智谱 API 请求失败：{last_error or '未知错误'}")
