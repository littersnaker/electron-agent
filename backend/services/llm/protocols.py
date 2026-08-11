"""LLM 供应商协议适配器。

本模块只负责 HTTP 请求、SSE 解析和统一消息格式转换；模型选择与降级策略留在
``gateway.py``，避免路由规则和厂商协议耦合在一个超大文件中。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from time import monotonic
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx

from backend.core.config import get_settings
from backend.services.llm.catalog import ModelDefinition
from backend.services.llm.types import LlmChunk, LlmMessage, LlmToolCall, LlmUsage

ErrorScope = Literal["model", "provider", "request"]

# 需要走代理的海外供应商；国内模型（qwen/deepseek/kimi/glm）直连。
PROXY_REQUIRED_PROVIDERS = frozenset({"openai", "gemini"})


class ProviderRequestError(ValueError):
    """表示供应商接口返回错误或网络调用失败。

    ``scope`` 用来区分错误属于单个模型还是整个供应商端点。Router 只有在
    ``model`` 错误时才继续尝试同供应商其他模型；网络、TLS、DNS、鉴权等
    ``provider`` 错误会直接跳到下一个供应商，避免重复请求同一个坏端点。
    """

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        scope: ErrorScope = "request",
        error_code: str | None = None,
        endpoint: str | None = None,
    ) -> None:
        """保存不含凭证的安全错误文本与结构化诊断字段。"""

        super().__init__(message)
        self.status_code = status_code
        self.scope = scope
        self.error_code = error_code
        self.endpoint = endpoint

    @property
    def provider_wide(self) -> bool:
        """返回该错误是否会影响同一供应商下的全部模型。"""

        return self.scope == "provider"


class LlmProtocolClient:
    """复用 HTTP 连接池并适配 OpenAI-compatible 与 Gemini 协议。"""

    def __init__(self) -> None:
        """创建直连与代理两套异步客户端。

        国内模型使用直连客户端（忽略 HTTP_PROXY/HTTPS_PROXY），避免代理不可用时
        拖慢 DeepSeek/Kimi/Qwen/GLM；OpenAI/Gemini 等海外模型走代理客户端。
        """

        timeout = httpx.Timeout(get_settings().request_timeout_seconds, connect=30.0)
        self._client = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            trust_env=True,
        )
        self._direct_client = httpx.AsyncClient(
            timeout=timeout,
            follow_redirects=True,
            trust_env=False,
        )

    async def close(self) -> None:
        """关闭 HTTP 连接池。"""

        await self._client.aclose()
        await self._direct_client.aclose()

    def _client_for(self, provider: str) -> httpx.AsyncClient:
        """按供应商选择走代理还是直连。"""

        return (
            self._client
            if provider in PROXY_REQUIRED_PROVIDERS
            else self._direct_client
        )

    async def measure_connectivity(
        self,
        *,
        model: ModelDefinition,
        endpoint: str,
        api_key: str,
    ) -> float:
        """只测量到响应头的纯网络延迟（毫秒），不等待模型生成内容。"""

        payload: dict[str, Any] = {
            "model": model.model,
            "messages": [{"role": "user", "content": "OK"}],
            "stream": True,
            "max_tokens": 1,
        }
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        client = self._client_for(model.provider)
        started = monotonic()
        async with client.stream(
            "POST",
            endpoint,
            headers=headers,
            json=payload,
        ) as response:
            elapsed_ms = (monotonic() - started) * 1000.0
            if response.status_code >= 400:
                raw = (await response.aread()).decode("utf-8", errors="replace")
                message, error_code = self._provider_error(
                    response.status_code,
                    raw,
                )
                raise ProviderRequestError(
                    message,
                    status_code=response.status_code,
                    scope=self._error_scope(
                        response.status_code,
                        error_code,
                        raw,
                    ),
                    error_code=error_code,
                    endpoint=endpoint,
                )
        return elapsed_ms

    async def stream_openai_compatible(
        self,
        *,
        model: ModelDefinition,
        endpoint: str,
        api_key: str,
        messages: list[LlmMessage],
        temperature: float | None,
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[LlmChunk]:
        """调用 OpenAI 兼容 ``chat/completions`` 流式接口。

        Kimi 与 OpenAI 官方接口支持通过 ``stream_options.include_usage`` 在最后一个
        数据块返回真实 Token 用量。其他兼容实现仍使用最小公共参数，避免扩展字段
        导致供应商返回 HTTP 400。
        """

        payload: dict[str, Any] = {
            "model": model.model,
            "messages": [self._to_openai_message(item) for item in messages],
            "stream": True,
        }
        if tools:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"
        if model.provider in {"kimi", "openai"}:
            # 优先获取供应商真实计费数据；网关仍保留本地估算作为兼容兜底。
            payload["stream_options"] = {"include_usage": True}
        # Kimi K2.5/K2.6 等模型会按思考模式限制 temperature。传入不兼容值会
        # 直接返回 HTTP 400，因此允许网关用 None 表示“交给供应商默认值”。
        if temperature is not None:
            payload["temperature"] = temperature
        headers = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }

        try:
            async with self._client_for(model.provider).stream(
                "POST",
                endpoint,
                headers=headers,
                json=payload,
            ) as response:
                if response.status_code >= 400:
                    raw = (await response.aread()).decode("utf-8", errors="replace")
                    message, error_code = self._provider_error(
                        response.status_code,
                        raw,
                    )
                    raise ProviderRequestError(
                        message,
                        status_code=response.status_code,
                        scope=self._error_scope(response.status_code, error_code, raw),
                        error_code=error_code,
                        endpoint=endpoint,
                    )

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    data = line[5:].strip()
                    if not data or data == "[DONE]":
                        continue
                    try:
                        packet = json.loads(data)
                    except json.JSONDecodeError:
                        continue
                    choices = packet.get("choices") or []
                    delta = choices[0].get("delta", {}) if choices else {}
                    text = delta.get("content") or ""
                    reasoning = (
                        delta.get("reasoning_content")
                        or delta.get("reasoning")
                        or ""
                    )
                    usage = self._read_openai_usage(packet.get("usage"))
                    tool_calls: list[LlmToolCall] = []
                    for call in delta.get("tool_calls") or []:
                        function = call.get("function") or {}
                        name = str(function.get("name") or "")
                        arguments = str(function.get("arguments") or "")
                        if name or arguments:
                            tool_calls.append(
                                LlmToolCall(
                                    name=name,
                                    arguments=arguments,
                                    id=str(call.get("id") or ""),
                                )
                            )
                    if text or reasoning or usage or tool_calls:
                        yield LlmChunk(
                            text_delta=text,
                            reasoning_delta=reasoning,
                            usage=usage,
                            tool_calls=tool_calls,
                        )
        except ProviderRequestError:
            raise
        except httpx.HTTPError as exc:
            raise ProviderRequestError(
                self._network_error(endpoint, exc),
                scope="provider",
                endpoint=endpoint,
            ) from exc

    async def stream_gemini(
        self,
        *,
        model: ModelDefinition,
        api_key: str,
        messages: list[LlmMessage],
        temperature: float,
        endpoint_base: str | None = None,
    ) -> AsyncIterator[LlmChunk]:
        """调用 Gemini ``streamGenerateContent`` SSE 接口。"""

        base = (
            endpoint_base or "https://generativelanguage.googleapis.com/v1beta"
        ).rstrip("/")
        if base.endswith(":streamGenerateContent"):
            url = base
        else:
            url = f"{base}/models/{model.model}:streamGenerateContent"
        system_text = "\n\n".join(
            item.content for item in messages if item.role == "system"
        )
        contents = [
            self._to_gemini_content(item)
            for item in messages
            if item.role != "system"
        ]
        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {"temperature": temperature},
        }
        if system_text:
            payload["systemInstruction"] = {"parts": [{"text": system_text}]}

        try:
            async with self._client_for(model.provider).stream(
                "POST",
                url,
                params={"key": api_key, "alt": "sse"},
                headers={"Content-Type": "application/json"},
                json=payload,
            ) as response:
                if response.status_code >= 400:
                    raw = (await response.aread()).decode("utf-8", errors="replace")
                    message, error_code = self._provider_error(
                        response.status_code,
                        raw,
                    )
                    raise ProviderRequestError(
                        message,
                        status_code=response.status_code,
                        scope=self._error_scope(response.status_code, error_code, raw),
                        error_code=error_code,
                        endpoint=url,
                    )

                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    try:
                        packet = json.loads(line[5:].strip())
                    except json.JSONDecodeError:
                        continue
                    text = self._gemini_text(packet)
                    usage = self._read_gemini_usage(packet.get("usageMetadata"))
                    if text or usage:
                        yield LlmChunk(text_delta=text, usage=usage)
        except ProviderRequestError:
            raise
        except httpx.HTTPError as exc:
            raise ProviderRequestError(
                self._network_error(url, exc),
                scope="provider",
                endpoint=url,
            ) from exc

    def _to_openai_message(self, message: LlmMessage) -> dict[str, Any]:
        """把统一消息转换成 OpenAI 兼容格式。"""

        if message.role == "tool":
            # 工具执行结果回填：必须携带对应的 tool_call_id。
            return {
                "role": "tool",
                "content": message.content,
                "tool_call_id": message.tool_call_id,
            }
        if message.tool_calls:
            # assistant 携带模型返回的原生 Function Call。
            return {
                "role": "assistant",
                "content": message.content or None,
                "tool_calls": [
                    {
                        "id": call.id or f"call_{index}",
                        "type": "function",
                        "function": {
                            "name": call.name,
                            "arguments": call.arguments,
                        },
                    }
                    for index, call in enumerate(message.tool_calls)
                ],
            }
        if not message.images:
            return {"role": message.role, "content": message.content}
        parts: list[dict[str, Any]] = [{"type": "text", "text": message.content}]
        for image in message.images:
            parts.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{image.mime_type};base64,{image.data}"
                    },
                }
            )
        return {"role": message.role, "content": parts}

    def _to_gemini_content(self, message: LlmMessage) -> dict[str, Any]:
        """把统一消息转换成 Gemini ``contents`` 格式。"""

        role = "model" if message.role == "assistant" else "user"
        parts: list[dict[str, Any]] = [{"text": message.content}]
        for image in message.images:
            parts.append(
                {
                    "inlineData": {
                        "mimeType": image.mime_type,
                        "data": image.data,
                    }
                }
            )
        return {"role": role, "parts": parts}

    def _gemini_text(self, packet: dict[str, Any]) -> str:
        """从 Gemini 响应中提取文本增量。"""

        candidates = packet.get("candidates") or []
        if not candidates:
            return ""
        parts = (candidates[0].get("content") or {}).get("parts") or []
        return "".join(str(part.get("text") or "") for part in parts)

    def _read_openai_usage(self, raw: object) -> LlmUsage | None:
        """解析 OpenAI 兼容用量字段。"""

        if not isinstance(raw, dict):
            return None
        prompt = int(raw.get("prompt_tokens") or 0)
        completion = int(raw.get("completion_tokens") or 0)
        total = int(raw.get("total_tokens") or prompt + completion)
        return LlmUsage(prompt, completion, total)

    def _read_gemini_usage(self, raw: object) -> LlmUsage | None:
        """解析 Gemini 用量字段。"""

        if not isinstance(raw, dict):
            return None
        prompt = int(raw.get("promptTokenCount") or 0)
        completion = int(raw.get("candidatesTokenCount") or 0)
        total = int(raw.get("totalTokenCount") or prompt + completion)
        return LlmUsage(prompt, completion, total)

    def _provider_error(self, status_code: int, raw: str) -> tuple[str, str | None]:
        """生成不会泄漏请求凭证的供应商错误信息和可选错误码。"""

        message = raw.strip()[:1000]
        error_code: str | None = None
        try:
            parsed = json.loads(raw)
            error = parsed.get("error") if isinstance(parsed, dict) else None
            if isinstance(error, dict):
                raw_code = error.get("code") or error.get("type")
                error_code = str(raw_code) if raw_code else None
                error_message = error.get("message")
                if error_code and error_message:
                    message = f"[{error_code}] {error_message}"
                else:
                    message = str(error_message or error_code or message)
            elif isinstance(error, str):
                message = error
            elif isinstance(parsed, dict):
                raw_code = parsed.get("code")
                error_code = str(raw_code) if raw_code else None
                message = str(parsed.get("message") or message)
        except json.JSONDecodeError:
            pass
        return f"HTTP {status_code}：{message or '未知错误'}", error_code

    def _error_scope(
        self,
        status_code: int,
        error_code: str | None,
        raw: str,
    ) -> ErrorScope:
        """判断错误是模型级、供应商级还是请求级。"""

        normalized = f"{error_code or ''} {raw}".lower()
        if status_code in {401, 403} or status_code >= 500:
            return "provider"
        if "workspace" in normalized and "not" in normalized:
            return "provider"
        if status_code == 404:
            return "model"
        if status_code == 400 and any(
            token in normalized
            for token in ("model_not_supported", "invalid_model", "model not")
        ):
            return "model"
        if status_code == 429:
            return "model"
        return "request"

    def _network_error(self, endpoint: str, exc: httpx.HTTPError) -> str:
        """把底层连接异常转换成可操作的中文诊断。"""

        host = urlsplit(endpoint).hostname or endpoint
        base = f"无法连接接口主机 {host}：{type(exc).__name__}: {exc}"
        if host.endswith("aliyuncs.com"):
            return (
                f"{base}。这是端点/网络错误，不是 Max、Plus 或 Flash 的模型兼容问题；"
                "请优先使用百炼控制台业务空间提供的 API Host，并检查 DNS、防火墙、"
                "HTTPS 代理及系统时间。"
            )
        return f"{base}。请检查 DNS、防火墙、HTTPS 代理及系统时间。"
