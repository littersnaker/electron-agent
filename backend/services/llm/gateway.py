"""统一 LLM 调用网关。

网关负责严格解析手动选择、构建 Auto 候选链、执行供应商/区域降级。业务接口不得
自行决定模型回退顺序，避免同一个 Key 在不同页面出现不一致行为。
"""

from __future__ import annotations

import asyncio
import logging
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass
from time import monotonic

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
    ) -> AsyncIterator[LlmChunk]:
        """统一返回流式增量；Auto 仅在尚未输出内容时切换候选模型。"""

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
    ) -> tuple[str, LlmUsage, ModelDefinition]:
        """收集完整响应；Auto 在没有收到任何内容时允许降级。

        ``timeout_seconds`` 控制单次模型调用的总时长上限；``stall_timeout_seconds``
        控制“没有新数据”的卡死阈值。默认只杀卡死流，不杀慢速但持续输出的长生成。
        """

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
            try:
                async for chunk in self._stream_with_deadline(
                    model=model,
                    credentials=credentials,
                    messages=messages,
                    temperature=temperature,
                    total_budget=total_budget,
                    stall_budget=stall_budget,
                ):
                    if chunk.reasoning_delta:
                        reasoning_parts.append(chunk.reasoning_delta)
                    if chunk.text_delta:
                        text_parts.append(chunk.text_delta)
                    if chunk.usage:
                        usage = chunk.usage
                result = "".join(text_parts).strip() or "".join(
                    reasoning_parts
                ).strip()
                # Moonshot 等兼容端点的流式响应可能不返回 usage。此处使用
                # 本地估算补齐统计，保证 Token Budget 与前端用量始终可用。
                usage = ensure_usage(usage, messages=messages, output_text=result)
                AVAILABILITY.mark_success(model, credentials)
                return result, usage, model
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

    async def _stream_with_deadline(
        self,
        *,
        model: ModelDefinition,
        credentials: LlmCredentials,
        messages: list[LlmMessage],
        temperature: float,
        total_budget: float,
        stall_budget: float,
    ) -> AsyncIterator[LlmChunk]:
        """流式读取模型输出：卡住才中断，慢速长生成不误杀。"""

        deadline = monotonic() + total_budget
        iterator = self._stream_model(
            model=model,
            credentials=credentials,
            messages=messages,
            temperature=temperature,
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
            except asyncio.TimeoutError:
                raise ProviderRequestError(
                    f"模型响应超过 {int(stall_budget)} 秒未返回数据，已终止本次调用",
                    scope="provider",
                )
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
    ) -> AsyncIterator[LlmChunk]:
        """按供应商协议执行一次模型请求，并处理同供应商区域端点回退。"""

        provider = get_provider(model.provider)
        api_key = credentials.get(model.provider)
        if not api_key:
            raise ValueError(f"未配置 {provider.name} API Key")

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
        ):
            yield chunk

    async def _stream_openai_provider(
        self,
        *,
        provider: ProviderDefinition,
        model: ModelDefinition,
        api_key: str,
        endpoint_override: str | None,
        messages: list[LlmMessage],
        temperature: float,
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
