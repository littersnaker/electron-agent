"""统一 LLM 调用网关。

本模块同时支持 OpenAI 兼容协议与 Gemini REST SSE。业务层只需要传入统一消息，
不需要了解不同供应商的 JSON 结构。
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from backend.core.config import get_settings
from backend.services.llm.catalog import (
    AUTO_MODEL_ID,
    MODELS,
    PROVIDERS,
    ModelDefinition,
    default_model_for_provider,
    get_model,
    get_provider,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.types import LlmChunk, LlmMessage, LlmUsage

LOGGER = logging.getLogger(__name__)


class LlmGateway:
    """根据模型、凭证和协议执行统一文本生成。"""

    def __init__(self) -> None:
        """创建复用连接池的异步 HTTP 客户端。"""

        timeout = httpx.Timeout(get_settings().request_timeout_seconds, connect=30.0)
        self._client = httpx.AsyncClient(timeout=timeout, follow_redirects=True)

    async def close(self) -> None:
        """关闭 HTTP 连接池。"""

        await self._client.aclose()

    def resolve_model(
        self, preferred_model_id: str, credentials: LlmCredentials
    ) -> ModelDefinition:
        """选择本次请求实际使用的模型。

        首先尝试用户选择的模型；如果该供应商没有 Key，则按注册表顺序寻找第一个
        已配置供应商，保证 ``auto`` 模式和模型故障降级可以正常工作。
        """

        preferred = get_model(preferred_model_id)
        if preferred and credentials.get(preferred.provider):
            return preferred

        for provider in PROVIDERS:
            if credentials.get(provider.id):
                return default_model_for_provider(provider.id)

        model_name = preferred.name if preferred else preferred_model_id or AUTO_MODEL_ID
        raise ValueError(
            f"模型 {model_name} 没有可用 API Key。请在右上角设置中配置至少一个供应商。"
        )

    async def stream(
        self,
        *,
        preferred_model_id: str,
        credentials: LlmCredentials,
        messages: list[LlmMessage],
        temperature: float = 0.2,
    ) -> AsyncIterator[LlmChunk]:
        """以统一格式流式返回模型增量内容。"""

        model = self.resolve_model(preferred_model_id, credentials)
        provider = get_provider(model.provider)
        api_key = credentials.get(model.provider)
        if not api_key:
            raise ValueError(f"未配置 {provider.name} API Key")

        if provider.protocol == "gemini":
            async for chunk in self._stream_gemini(
                model=model, api_key=api_key, messages=messages, temperature=temperature
            ):
                yield chunk
            return

        async for chunk in self._stream_openai_compatible(
            model=model,
            endpoint=provider.default_endpoint or "",
            api_key=api_key,
            messages=messages,
            temperature=temperature,
        ):
            yield chunk

    async def complete(
        self,
        *,
        preferred_model_id: str,
        credentials: LlmCredentials,
        messages: list[LlmMessage],
        temperature: float = 0.2,
    ) -> tuple[str, LlmUsage, ModelDefinition]:
        """收集完整模型响应，适合规划、JSON 提案等非流式任务。"""

        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        usage = LlmUsage()
        model = self.resolve_model(preferred_model_id, credentials)
        async for chunk in self.stream(
            preferred_model_id=model.id,
            credentials=credentials,
            messages=messages,
            temperature=temperature,
        ):
            # 结构化任务只使用模型的最终答案，避免把思考过程混进 JSON。
            # 极少数模型如果只返回 reasoning，再把它作为兼容兜底。
            if chunk.reasoning_delta:
                reasoning_parts.append(chunk.reasoning_delta)
            if chunk.text_delta:
                text_parts.append(chunk.text_delta)
            if chunk.usage:
                usage = chunk.usage
        result_text = "".join(text_parts).strip() or "".join(reasoning_parts).strip()
        return result_text, usage, model

    async def _stream_openai_compatible(
        self,
        *,
        model: ModelDefinition,
        endpoint: str,
        api_key: str,
        messages: list[LlmMessage],
        temperature: float,
    ) -> AsyncIterator[LlmChunk]:
        """调用 OpenAI 兼容的 ``chat/completions`` 流式接口。"""

        payload = {
            "model": model.model,
            "messages": [self._to_openai_message(message) for message in messages],
            "stream": True,
            "stream_options": {"include_usage": True},
            "temperature": temperature,
        }
        headers = {"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"}

        async with self._client.stream("POST", endpoint, headers=headers, json=payload) as response:
            if response.status_code >= 400:
                raw = (await response.aread()).decode("utf-8", errors="replace")
                raise ValueError(self._provider_error(response.status_code, raw))

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
                reasoning = delta.get("reasoning_content") or delta.get("reasoning") or ""
                usage = self._read_openai_usage(packet.get("usage"))
                if text or reasoning or usage:
                    yield LlmChunk(text_delta=text, reasoning_delta=reasoning, usage=usage)

    async def _stream_gemini(
        self,
        *,
        model: ModelDefinition,
        api_key: str,
        messages: list[LlmMessage],
        temperature: float,
    ) -> AsyncIterator[LlmChunk]:
        """调用 Gemini ``streamGenerateContent`` SSE 接口。"""

        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{model.model}:streamGenerateContent"
        )
        system_text = "\n\n".join(
            message.content for message in messages if message.role == "system"
        )
        contents = [
            self._to_gemini_content(message)
            for message in messages
            if message.role != "system"
        ]
        payload: dict[str, Any] = {
            "contents": contents,
            "generationConfig": {"temperature": temperature},
        }
        if system_text:
            payload["systemInstruction"] = {"parts": [{"text": system_text}]}

        async with self._client.stream(
            "POST",
            url,
            params={"key": api_key, "alt": "sse"},
            headers={"Content-Type": "application/json"},
            json=payload,
        ) as response:
            if response.status_code >= 400:
                raw = (await response.aread()).decode("utf-8", errors="replace")
                raise ValueError(self._provider_error(response.status_code, raw))

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

    def _to_openai_message(self, message: LlmMessage) -> dict[str, Any]:
        """把统一消息转换成 OpenAI 兼容格式。"""

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

    def _provider_error(self, status_code: int, raw: str) -> str:
        """生成不会泄漏请求凭证的供应商错误信息。"""

        message = raw.strip()[:1000]
        try:
            parsed = json.loads(raw)
            error = parsed.get("error") if isinstance(parsed, dict) else None
            if isinstance(error, dict):
                message = str(error.get("message") or error.get("code") or message)
            elif isinstance(error, str):
                message = error
        except json.JSONDecodeError:
            pass
        return f"模型供应商请求失败（HTTP {status_code}）：{message or '未知错误'}"


GATEWAY = LlmGateway()
