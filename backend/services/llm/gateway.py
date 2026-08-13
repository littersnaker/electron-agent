"""统一 LLM 调用网关。

网关负责严格解析手动选择、构建 Auto 候选链、执行供应商/区域降级。业务接口不得
自行决定模型回退顺序，避免同一个 Key 在不同页面出现不一致行为。
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass, replace
from time import monotonic
from typing import Any

from backend.core import request_audit
from backend.core.builtin_credentials import get_builtin_value
from backend.services.llm.availability import AVAILABILITY
from backend.services.llm.catalog import (
    AUTO_MODEL_ID,
    MODELS,
    PROVIDERS,
    ModelDefinition,
    ProviderDefinition,
    get_model,
    get_provider,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.custom_models import (
    get_custom_model_definition,
    list_custom_model_definitions,
)
from backend.services.llm.protocols import LlmProtocolClient, ProviderRequestError
from backend.services.llm.token_usage import ensure_usage
from backend.services.llm.types import LlmChunk, LlmMessage, LlmUsage

LOGGER = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ProviderFailure:
    """记录一次不含密钥的模型调用失败，供最终错误汇总使用。"""

    model_name: str
    provider_name: str
    detail: str
    scope: str


def _usage_payload(usage: LlmUsage | None) -> dict[str, int] | None:
    """把 token 用量转成审计友好的 JSON 结构。"""

    if usage is None:
        return None
    return {
        "prompt": usage.prompt,
        "completion": usage.completion,
        "total": usage.total,
        "cached": usage.cached_tokens,
    }


def _ttft_ms(started: float, first_chunk_at: float | None) -> int | None:
    """首 token 延迟（毫秒）；无输出时返回 None。"""

    if first_chunk_at is None:
        return None
    return max(0, int((first_chunk_at - started) * 1000))


def _tok_per_sec(
    usage: LlmUsage | None,
    first_chunk_at: float | None,
    finished_at: float | None = None,
) -> float | None:
    """输出吞吐（tok/s）：completion ÷ 首 token 到完成的时间。"""

    if usage is None or first_chunk_at is None or finished_at is None:
        return None
    decode_seconds = max(0.001, finished_at - first_chunk_at)
    return round(usage.completion / decode_seconds, 1) if usage.completion else None


async def _record_step_metric(
    *,
    request_id: str,
    audit_info: Any,
    provider: str,
    model: str,
    usage: LlmUsage | None,
    ttft_ms: int | None,
    total_ms: int,
) -> None:
    """把一次 LLM 调用的性能指标落库（失败只告警，不影响主流程）。"""

    if usage is None:
        return
    agent = audit_info if isinstance(audit_info, dict) else {}
    # effective_audit 返回 camelCase 键（agentId/sessionId/parentRequestId）。
    work_id = str(
        agent.get("parentRequestId")
        or agent.get("parent_request_id")
        or ""
    )
    session_id = str(agent.get("sessionId") or agent.get("session_id") or "")
    try:
        from backend.services.quality.step_metrics import record_step_metric

        await record_step_metric(
            request_id=request_id,
            session_id=session_id,
            work_id=work_id,
            provider=provider,
            model=model,
            ttft_ms=ttft_ms,
            tok_per_sec=usage.completion / max(0.001, total_ms / 1000)
            if usage.completion and total_ms
            else None,
            prompt_tokens=usage.prompt,
            completion_tokens=usage.completion,
            cached_tokens=usage.cached_tokens,
            total_ms=total_ms,
        )
    except Exception as exc:  # noqa: BLE001 - 指标采集失败不影响 LLM 调用。
        LOGGER.debug("step metric 落库失败：%s", exc)


class LlmGateway:
    """根据模型、凭证、输入能力和协议执行统一文本生成。"""

    def __init__(self) -> None:
        """创建协议客户端。"""

        self._protocols = LlmProtocolClient()

    async def close(self) -> None:
        """关闭 HTTP 连接池。"""

        await self._protocols.close()

    def resolve_candidates(
        self,
        preferred_model_id: str,
        credentials: LlmCredentials,
        messages: list[LlmMessage],
    ) -> tuple[ModelDefinition, ...]:
        """解析本次调用候选链。

        手动选择模型时只调用该模型，绝不静默偷换供应商。Auto 模式会把首选模型
        与允许降级的后备模型一起纳入候选，并优先使用最近验证成功的模型。
        """

        requested = (preferred_model_id or AUTO_MODEL_ID).strip() or AUTO_MODEL_ID
        requires_vision = any(message.images for message in messages)
        required = {"text", "stream"}
        if requires_vision:
            required.add("vision")

        if requested != AUTO_MODEL_ID:
            selected = get_custom_model_definition(requested) or get_model(requested)
            if not selected:
                raise ValueError(f"未识别的模型：{requested}，请重新选择模型。")
            provider = get_provider(selected.provider)
            if not credentials.get(selected.provider):
                raise ValueError(
                    f"已选择 {selected.name}，但未配置 {provider.name} API Key。"
                )
            missing = required.difference(selected.capabilities)
            if missing:
                capability = "图像输入" if "vision" in missing else "当前任务"
                raise ValueError(f"模型 {selected.name} 不支持{capability}，请更换模型。")
            return (selected,)

        runtime_models = (*list_custom_model_definitions(), *MODELS)
        eligible = tuple(
            sorted(
                (
                    model
                    for model in runtime_models
                    if model.chat_compatible
                    and (model.auto_select or model.fallback_select)
                    and credentials.get(model.provider)
                    and required.issubset(model.capabilities)
                ),
                key=lambda model: model.auto_priority,
            )
        )
        candidates = AVAILABILITY.order_candidates(eligible, credentials)
        if candidates:
            return candidates

        configured_names = [
            provider.name for provider in PROVIDERS if credentials.get(provider.id)
        ]
        if configured_names and requires_vision:
            raise ValueError(
                "已配置的模型均不支持图像输入，请配置或选择支持 Vision 的模型。"
            )
        raise ValueError("没有可用 API Key，请在右上角设置中配置至少一个模型供应商。")

    async def stream(
        self,
        *,
        preferred_model_id: str,
        credentials: LlmCredentials,
        messages: list[LlmMessage],
        temperature: float = 0.2,
        audit: dict[str, Any] | None = None,
    ) -> AsyncIterator[LlmChunk]:
        """统一返回流式增量；Auto 仅在尚未输出内容时切换候选模型。

        每次调用都会写入请求审计日志（requestId + Agent 身份 + 参数 + 结果）。
        """

        audit_info = request_audit.effective_audit(audit)
        request_id = request_audit.new_request_id("llm")
        started = monotonic()
        request_payload: dict[str, Any] = {
            "model": preferred_model_id,
            "temperature": temperature,
            "messages": self._audit_messages_payload(messages),
            "candidates": [],
        }
        try:
            request_payload["candidates"] = [
                {"model": model.model, "provider": model.provider}
                for model in self.resolve_candidates(
                    preferred_model_id, credentials, messages
                )
            ]
        except Exception as exc:
            request_payload["candidatesError"] = str(exc)
        last_usage: LlmUsage | None = None
        first_chunk_at: float | None = None
        try:
            async for chunk in self._stream_impl(
                preferred_model_id=preferred_model_id,
                credentials=credentials,
                messages=messages,
                temperature=temperature,
            ):
                if first_chunk_at is None:
                    first_chunk_at = monotonic()
                if chunk.usage:
                    last_usage = chunk.usage
                yield chunk
        except Exception as exc:
            request_audit.record(
                kind="llm.stream",
                request_id=request_id,
                status="error",
                duration_ms=request_audit.duration_ms(started),
                request=request_payload,
                response={"error": str(exc)},
                agent=audit_info,
                error=str(exc),
            )
            raise
        ttft_ms = _ttft_ms(started, first_chunk_at)
        request_audit.record(
            kind="llm.stream",
            request_id=request_id,
            status="success",
            duration_ms=request_audit.duration_ms(started),
            request=request_payload,
            response={
                "stream": True,
                "finished": True,
                "usage": _usage_payload(last_usage),
                "ttftMs": ttft_ms,
                "tokPerSec": _tok_per_sec(last_usage, first_chunk_at),
            },
            agent=audit_info,
        )
        await _record_step_metric(
            request_id=request_id,
            audit_info=audit_info,
            provider=request_payload.get("candidates", [{}])[0].get("provider", "")
            if request_payload.get("candidates")
            else "",
            model=request_payload.get("candidates", [{}])[0].get("model", "")
            if request_payload.get("candidates")
            else "",
            usage=last_usage,
            ttft_ms=ttft_ms,
            total_ms=request_audit.duration_ms(started),
        )

    async def _stream_impl(
        self,
        *,
        preferred_model_id: str,
        credentials: LlmCredentials,
        messages: list[LlmMessage],
        temperature: float = 0.2,
    ) -> AsyncIterator[LlmChunk]:
        """原始流式实现，供 stream() 审计包装调用。"""

        candidates = self.resolve_candidates(
            preferred_model_id,
            credentials,
            messages,
        )
        automatic = (preferred_model_id or AUTO_MODEL_ID).strip() == AUTO_MODEL_ID
        failures: list[ProviderFailure] = []
        blocked_routes: set[tuple[str, str]] = set()

        for model in candidates:
            route_group = self._route_group(model)
            if route_group in blocked_routes:
                continue
            emitted = False
            try:
                async for chunk in self._stream_model(
                    model=model,
                    credentials=credentials,
                    messages=messages,
                    temperature=temperature,
                ):
                    emitted = True
                    yield chunk
                AVAILABILITY.mark_success(model, credentials)
                return
            except ProviderRequestError as exc:
                provider = get_provider(model.provider)
                failures.append(
                    ProviderFailure(
                        model.name,
                        provider.name,
                        str(exc),
                        exc.scope,
                    )
                )
                AVAILABILITY.mark_failure(model, credentials, exc.scope)
                # 已输出后切模型会拼接两个回答；手动选择也必须原样报告错误。
                if emitted or not automatic:
                    raise
                if exc.provider_wide:
                    blocked_routes.add(route_group)
                LOGGER.warning(
                    "Auto Router 调用 %s/%s 失败，scope=%s，尝试下一个候选：%s",
                    provider.id,
                    model.model,
                    exc.scope,
                    exc,
                )

        raise ValueError(self._format_failures(failures))

    async def complete(
        self,
        *,
        preferred_model_id: str,
        credentials: LlmCredentials,
        messages: list[LlmMessage],
        temperature: float = 0.2,
        timeout_seconds: float | None = None,
        stall_timeout_seconds: float | None = None,
        audit: dict[str, Any] | None = None,
        tools: list[dict[str, Any]] | None = None,
    ) -> tuple[str, LlmUsage, ModelDefinition]:
        """收集完整响应；Auto 在没有收到任何内容时允许降级。

        ``timeout_seconds`` 控制单次模型调用的总时长上限；``stall_timeout_seconds``
        控制“没有新数据”的卡死阈值。默认只杀卡死流，不杀慢速但持续输出的长生成。
        每次调用都会写入请求审计日志（requestId + Agent 身份 + 参数 + 结果）。

        ``tools`` 为 OpenAI 兼容 Function Calling 工具 Schema。模型返回工具调用时，
        返回文本为该工具调用的 ``arguments`` JSON（与文本协议的 ``{"action":...}``
        格式一致，解析方无需改动）。
        """

        audit_info = request_audit.effective_audit(audit)
        request_id = request_audit.new_request_id("llm")
        started = monotonic()
        request_payload: dict[str, Any] = {
            "model": preferred_model_id,
            "temperature": temperature,
            "messages": self._audit_messages_payload(messages),
            "candidates": [],
        }
        if tools:
            request_payload["tools"] = tools
        try:
            request_payload["candidates"] = [
                {"model": model.model, "provider": model.provider}
                for model in self.resolve_candidates(
                    preferred_model_id, credentials, messages
                )
            ]
        except Exception as exc:
            request_payload["candidatesError"] = str(exc)
        try:
            result = await self._complete_impl(
                preferred_model_id=preferred_model_id,
                credentials=credentials,
                messages=messages,
                temperature=temperature,
                timeout_seconds=timeout_seconds,
                stall_timeout_seconds=stall_timeout_seconds,
                tools=tools,
            )
        except Exception as exc:
            request_audit.record(
                kind="llm.complete",
                request_id=request_id,
                status="error",
                duration_ms=request_audit.duration_ms(started),
                request=request_payload,
                response={"error": str(exc)},
                agent=audit_info,
                error=str(exc),
            )
            raise
        text, usage, model, first_chunk_at = result
        # 真实首 token 延迟：_complete_impl 已记录首个 chunk 到达时间，不再用总耗时近似。
        ttft_ms = _ttft_ms(started, first_chunk_at)
        request_audit.record(
            kind="llm.complete",
            request_id=request_id,
            status="success",
            duration_ms=request_audit.duration_ms(started),
            request=request_payload,
            response={
                "text": text,
                "usage": _usage_payload(usage),
                "model": model.model,
                "provider": model.provider,
                "name": model.name,
                "ttftMs": ttft_ms,
            },
            agent=audit_info,
        )
        await _record_step_metric(
            request_id=request_id,
            audit_info=audit_info,
            provider=model.provider,
            model=model.model,
            usage=usage,
            ttft_ms=ttft_ms,
            total_ms=request_audit.duration_ms(started),
        )
        # 公共签名保持三元组；first_chunk_at 只用于审计与指标落库。
        return text, usage, model

    async def _complete_impl(
        self,
        *,
        preferred_model_id: str,
        credentials: LlmCredentials,
        messages: list[LlmMessage],
        temperature: float = 0.2,
        timeout_seconds: float | None = None,
        stall_timeout_seconds: float | None = None,
        tools: list[dict[str, Any]] | None = None,
    ) -> tuple[str, LlmUsage, ModelDefinition, float | None]:
        """原始完整响应实现，供 complete() 审计包装调用。第四项是首 chunk 时间戳。"""

        candidates = self.resolve_candidates(
            preferred_model_id,
            credentials,
            messages,
        )
        automatic = (preferred_model_id or AUTO_MODEL_ID).strip() == AUTO_MODEL_ID
        total_budget = max(1.0, timeout_seconds or 900.0)
        stall_budget = max(0.5, stall_timeout_seconds or 90.0)
        failures: list[ProviderFailure] = []
        blocked_routes: set[tuple[str, str]] = set()

        for model in candidates:
            route_group = self._route_group(model)
            if route_group in blocked_routes:
                continue
            text_parts: list[str] = []
            reasoning_parts: list[str] = []
            usage = LlmUsage()
            first_chunk_at: float | None = None
            # 流式 Function Calling 按 id 分片累加 arguments，结束后拼接成完整 JSON。
            tool_calls_map: dict[str, dict[str, str]] = {}
            tool_calls_order: list[str] = []
            try:
                async for chunk in self._stream_with_deadline(
                    model=model,
                    credentials=credentials,
                    messages=messages,
                    temperature=temperature,
                    total_budget=total_budget,
                    stall_budget=stall_budget,
                    tools=tools,
                ):
                    if first_chunk_at is None:
                        first_chunk_at = monotonic()
                    if chunk.reasoning_delta:
                        reasoning_parts.append(chunk.reasoning_delta)
                    if chunk.text_delta:
                        text_parts.append(chunk.text_delta)
                    if chunk.usage:
                        usage = chunk.usage
                    for call in chunk.tool_calls:
                        if call.id:
                            # 供应商带 id：按 id 分组累加同一次 tool_call 的分片。
                            key = call.id
                            if key not in tool_calls_map:
                                tool_calls_map[key] = {"name": "", "arguments": ""}
                                tool_calls_order.append(key)
                        elif tool_calls_order:
                            # DeepSeek 等供应商流式分片不带 id：续接到当前
                            # 最后一个 tool_call，避免每个分片被当成独立调用
                            # 导致 arguments 被拆散、首个为空。
                            key = tool_calls_order[-1]
                        else:
                            key = f"call_{len(tool_calls_order)}"
                            tool_calls_map[key] = {"name": "", "arguments": ""}
                            tool_calls_order.append(key)
                        if call.name:
                            tool_calls_map[key]["name"] = call.name
                        if call.arguments:
                            tool_calls_map[key]["arguments"] += call.arguments
                if tool_calls_order:
                    # 工具调用优先：返回第一个 tool_call 的 arguments JSON，
                    # 与文本协议 {"action":...} 兼容，worker 解析无需改动。
                    first = tool_calls_map[tool_calls_order[0]]
                    result = first["arguments"].strip()
                else:
                    result = "".join(text_parts).strip() or "".join(
                        reasoning_parts
                    ).strip()
                # Moonshot 等兼容端点的流式响应可能不返回 usage。此处使用
                # 本地估算补齐统计，保证 Token Budget 与前端用量始终可用。
                usage = ensure_usage(usage, messages=messages, output_text=result)
                AVAILABILITY.mark_success(model, credentials)
                return result, usage, model, first_chunk_at
            except ProviderRequestError as exc:
                provider = get_provider(model.provider)
                failures.append(
                    ProviderFailure(
                        model.name,
                        provider.name,
                        str(exc),
                        exc.scope,
                    )
                )
                AVAILABILITY.mark_failure(model, credentials, exc.scope)
                if text_parts or reasoning_parts or not automatic:
                    raise
                if exc.provider_wide:
                    blocked_routes.add(route_group)

        raise ValueError(self._format_failures(failures))

    @staticmethod
    def _audit_messages_payload(messages: list[LlmMessage]) -> list[dict[str, Any]]:
        """把模型消息转成审计载荷：文本截断、图片只保留元信息。"""

        max_chars = request_audit._max_message_chars()
        payload: list[dict[str, Any]] = []
        for message in messages:
            item: dict[str, Any] = {
                "role": message.role,
                "content": request_audit.truncate_text(message.content, max_chars),
            }
            if message.images:
                item["images"] = [
                    {
                        "mimeType": image.mime_type,
                        "bytes": len(image.data),
                    }
                    for image in message.images
                ]
            payload.append(item)
        return payload

    async def _stream_with_deadline(
        self,
        *,
        model: ModelDefinition,
        credentials: LlmCredentials,
        messages: list[LlmMessage],
        temperature: float,
        total_budget: float,
        stall_budget: float,
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[LlmChunk]:
        """流式读取模型输出：卡住才中断，慢速长生成不误杀。"""

        deadline = monotonic() + total_budget
        iterator = self._stream_model(
            model=model,
            credentials=credentials,
            messages=messages,
            temperature=temperature,
            tools=tools,
        ).__aiter__()
        while True:
            remaining = deadline - monotonic()
            if remaining <= 0:
                raise ProviderRequestError(
                    f"模型响应超过 {int(total_budget)} 秒仍未完成，已终止本次调用",
                    scope="provider",
                )
            try:
                chunk = await asyncio.wait_for(
                    anext(iterator),
                    timeout=min(stall_budget, remaining),
                )
            except StopAsyncIteration:
                return
            except TimeoutError:
                raise ProviderRequestError(
                    f"模型响应超过 {int(stall_budget)} 秒未返回数据，已终止本次调用",
                    scope="provider",
                ) from None
            yield chunk

    async def probe(
        self,
        *,
        model_id: str,
        credentials: LlmCredentials,
    ) -> tuple[ModelDefinition, float]:
        """验证 Key/端点/模型名，并返回到响应头的纯网络延迟（毫秒）。

        纯网络延迟只等待 HTTP 响应头，不包含模型生成时间；完整流仍会读完，
        确保供应商端不会因提前取消而误报。
        """

        model = get_custom_model_definition(model_id) or get_model(model_id)
        if not model:
            raise ValueError(f"未识别的模型：{model_id}")
        provider = get_provider(model.provider)
        api_key = credentials.get(model.provider)
        if not api_key:
            raise ValueError(f"未配置 {provider.name} API Key")
        endpoints = self._provider_endpoints(
            provider,
            model.base_url or credentials.get_endpoint(model.provider),
        )
        network_ms = 0.0
        last_error: ProviderRequestError | None = None
        for endpoint in endpoints:
            try:
                network_ms = await self._protocols.measure_connectivity(
                    model=model,
                    endpoint=endpoint,
                    api_key=api_key,
                )
                break
            except ProviderRequestError as exc:
                last_error = exc
                can_try_region = (
                    exc.status_code is None or exc.status_code in {401, 403, 404}
                )
                if not can_try_region or endpoint == endpoints[-1]:
                    raise
        if last_error is not None:
            raise last_error
        messages = [LlmMessage("user", "只回复 OK")]
        async for _chunk in self.stream(
            preferred_model_id=model.id,
            credentials=credentials,
            messages=messages,
            temperature=0.0,
            audit={"agentRole": "probe"},
        ):
            # 自然读取到流结束，避免过早取消 HTTP/2 连接造成供应商误报。
            pass
        AVAILABILITY.mark_success(model, credentials)
        return model, max(0.0, network_ms)

    async def _stream_model(
        self,
        *,
        model: ModelDefinition,
        credentials: LlmCredentials,
        messages: list[LlmMessage],
        temperature: float,
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[LlmChunk]:
        """按供应商协议执行一次模型请求，并处理同供应商区域端点回退。"""

        provider = get_provider(model.provider)
        api_key = credentials.get(model.provider)
        if not api_key:
            raise ValueError(f"未配置 {provider.name} API Key")

        # 让 Agent 在上下文中自知当前实际使用的模型（含 Auto 降级后的真身）。
        # 每个候选模型调用时注入的都是它自己的名字，与实际调用完全一致。
        messages = self._inject_model_context(model, messages)

        if provider.protocol == "gemini":
            async for chunk in self._protocols.stream_gemini(
                model=model,
                api_key=api_key,
                messages=messages,
                temperature=temperature,
                endpoint_base=model.base_url,
            ):
                yield chunk
            return

        async for chunk in self._stream_openai_provider(
            provider=provider,
            model=model,
            api_key=api_key,
            endpoint_override=model.base_url or credentials.get_endpoint(model.provider),
            messages=messages,
            temperature=temperature,
            tools=tools,
        ):
            yield chunk

    @staticmethod
    def _inject_model_context(
        model: ModelDefinition,
        messages: list[LlmMessage],
    ) -> list[LlmMessage]:
        """把当前实际模型信息追加到首条 system 消息（浅拷贝，无副作用）。"""

        note = (
            "\n\n【当前模型】"
            f"{model.name}（{model.provider}/{model.model}）。"
            "若用户询问使用的模型或版本，请如实告知。"
        )
        result: list[LlmMessage] = []
        injected = False
        for message in messages:
            if message.role == "system" and not injected:
                result.append(
                    replace(
                        message,
                        content=f"{message.content}{note}",
                    )
                )
                injected = True
            else:
                result.append(message)
        if not injected:
            # 没有 system 消息时放在开头，保证模型始终知道当前身份。
            result.insert(
                0,
                LlmMessage(
                    "system",
                    f"你当前使用的模型：{model.name}（{model.provider}/{model.model}）。",
                ),
            )
        return result

    async def _stream_openai_provider(
        self,
        *,
        provider: ProviderDefinition,
        model: ModelDefinition,
        api_key: str,
        endpoint_override: str | None,
        messages: list[LlmMessage],
        temperature: float,
        tools: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[LlmChunk]:
        """依次尝试供应商区域端点；收到内容后绝不切换端点。"""

        endpoints = self._provider_endpoints(provider, endpoint_override)
        request_temperature = self._request_temperature(provider, model, temperature)
        last_error: ProviderRequestError | None = None
        for index, endpoint in enumerate(endpoints):
            emitted = False
            try:
                async for chunk in self._protocols.stream_openai_compatible(
                    model=model,
                    endpoint=endpoint,
                    api_key=api_key,
                    messages=messages,
                    temperature=request_temperature,
                    tools=tools,
                ):
                    emitted = True
                    yield chunk
                return
            except ProviderRequestError as exc:
                last_error = exc
                can_try_region = (
                    not emitted
                    and index < len(endpoints) - 1
                    and (
                        exc.status_code is None
                        or exc.status_code in {401, 403, 404}
                    )
                )
                if not can_try_region:
                    raise
                LOGGER.info(
                    "%s 当前区域端点不可用，尝试备用区域端点（HTTP %s）",
                    provider.id,
                    exc.status_code or "network",
                )

        if last_error:
            raise last_error
        raise ProviderRequestError(
            f"{provider.name} 未配置可用接口地址",
            scope="provider",
        )


    def _request_temperature(
        self,
        provider: ProviderDefinition,
        model: ModelDefinition,
        requested: float,
    ) -> float | None:
        """按供应商模型约束决定是否发送 temperature。

        Kimi K2.5/K2.6 的思考模式固定为 1.0，非思考模式固定为 0.6。应用
        当前没有显式发送 thinking，因此最稳妥的兼容方式是省略 temperature，
        让平台使用该模型的合法默认值。其他模型保持业务层传入值。
        """

        model_name = model.model.strip().lower()
        if provider.id == "kimi" and (
            model_name.startswith("kimi-k2.6")
            or model_name.startswith("kimi-k2.5")
            or model_name.startswith("kimi-k2-thinking")
        ):
            return None
        return max(0.0, min(float(requested), 1.0 if provider.id == "kimi" else 2.0))

    def _provider_endpoints(
        self,
        provider: ProviderDefinition,
        request_override: str | None = None,
    ) -> tuple[str, ...]:
        """返回实际调用端点，并允许环境变量或内置配置覆盖。

        百炼工作空间 Key 可能绑定专属地域或工作空间域名。优先级依次为请求头、
        ``DASHSCOPE_BASE_URL``、构建期内置值和默认公共端点。请求头可填写控制台
        提供的 ``.../compatible-mode/v1`` Base URL。
        """

        environment_key = provider.endpoint_environment_key
        environment_override = (
            os.getenv(environment_key, "").strip() if environment_key else ""
        )
        builtin_override = (
            get_builtin_value(environment_key) if environment_key else ""
        )
        override = (
            (request_override or "").strip()
            or environment_override
            or builtin_override
        )
        if override:
            if not override.startswith(("https://", "http://")):
                # 常见配置错误：把 API Key 填进了 Base URL 字段/环境变量。
                # 忽略该覆盖并回退默认端点，避免拼出 "unknown url type"。
                LOGGER.warning(
                    "忽略无效的 %s Base URL 覆盖：必须以 http(s):// 开头"
                    "（可能把 API Key 填进了 Base URL 字段）",
                    provider.id,
                )
            else:
                return (self._normalize_chat_endpoint(override),)
        return tuple(
            endpoint
            for endpoint in (provider.default_endpoint, *provider.fallback_endpoints)
            if endpoint
        )

    def _normalize_chat_endpoint(self, endpoint: str) -> str:
        """把供应商 Base URL 规范成 OpenAI 兼容聊天接口地址。"""

        normalized = endpoint.rstrip("/")
        if normalized.endswith("/chat/completions"):
            return normalized
        return f"{normalized}/chat/completions"


    def _route_group(self, model: ModelDefinition) -> tuple[str, str]:
        """返回端点级熔断分组，避免一个自定义地址拖累同供应商其他地址。"""

        return (model.provider, (model.base_url or "provider-default").rstrip("/"))

    def _format_failures(self, failures: list[ProviderFailure]) -> str:
        """把 Auto Router 多次失败压缩成可操作的中文错误。"""

        if not failures:
            return "Auto Router 没有找到可用模型。"
        details = "；".join(
            f"{item.provider_name}/{item.model_name}: {item.detail}"
            for item in failures
        )
        has_provider_failure = any(item.scope == "provider" for item in failures)
        guidance = (
            " 其中包含端点级错误：这类错误与 Max/Plus/Flash 的向下兼容无关，"
            "Router 已跳过同端点的重复模型请求；请先修复 API Host、DNS、代理或鉴权。"
            if has_provider_failure
            else ""
        )
        return f"Auto Router 已尝试可用候选但均失败：{details}{guidance}"


GATEWAY = LlmGateway()
