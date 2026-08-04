"""LLM 供应商与模型注册表。

供应商地址仍在本文件中维护；聊天模型列表由 ``config/chat-models.json`` 生成。
开发时保存 JSON 后，models watcher 会同时刷新 Python 与 TypeScript 注册表。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast

from backend.services.llm.catalog_generated import (
    DEFAULT_MODEL_ID,
    MODEL_CATALOG_DATA,
    MODEL_ID_ALIASES,
)


ProviderId = Literal["qwen", "openai", "gemini", "deepseek", "glm", "kimi"]
Protocol = Literal["openai-compatible", "gemini"]


@dataclass(frozen=True, slots=True)
class ProviderDefinition:
    """描述一个模型供应商的鉴权方式和默认接口地址。"""

    id: ProviderId
    name: str
    environment_key: str
    request_header: str
    protocol: Protocol
    default_endpoint: str | None = None
    fallback_endpoints: tuple[str, ...] = ()
    endpoint_environment_key: str | None = None


@dataclass(frozen=True, slots=True)
class ModelDefinition:
    """描述逻辑 ID、厂商真实模型名和 Auto Router 属性。"""

    id: str
    provider: ProviderId
    model: str
    name: str
    description: str
    capabilities: tuple[str, ...]
    chat_compatible: bool = True
    auto_select: bool = True
    fallback_select: bool = False
    auto_priority: int = 100
    # 自定义模型可单独指定完整 Base URL；内置模型保持 None。
    base_url: str | None = None
    is_custom: bool = False


PROVIDERS: tuple[ProviderDefinition, ...] = (
    ProviderDefinition(
        "qwen",
        "Qwen / DashScope",
        "DASHSCOPE_API_KEY",
        "x-llm-key-qwen",
        "openai-compatible",
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
        (
            "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions",
            "https://dashscope-us.aliyuncs.com/compatible-mode/v1/chat/completions",
        ),
        "DASHSCOPE_BASE_URL",
    ),
    ProviderDefinition(
        "openai",
        "OpenAI",
        "OPENAI_API_KEY",
        "x-llm-key-openai",
        "openai-compatible",
        "https://api.openai.com/v1/chat/completions",
        endpoint_environment_key="OPENAI_BASE_URL",
    ),
    ProviderDefinition(
        "gemini",
        "Google Gemini",
        "GEMINI_API_KEY",
        "x-llm-key-gemini",
        "gemini",
    ),
    ProviderDefinition(
        "deepseek",
        "DeepSeek",
        "DEEPSEEK_API_KEY",
        "x-llm-key-deepseek",
        "openai-compatible",
        "https://api.deepseek.com/chat/completions",
        endpoint_environment_key="DEEPSEEK_BASE_URL",
    ),
    ProviderDefinition(
        "glm",
        "GLM / BigModel",
        "GLM_API_KEY",
        "x-llm-key-glm",
        "openai-compatible",
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        endpoint_environment_key="GLM_BASE_URL",
    ),
    ProviderDefinition(
        "kimi",
        "Kimi / Moonshot",
        "KIMI_API_KEY",
        "x-llm-key-kimi",
        "openai-compatible",
        "https://api.moonshot.cn/v1/chat/completions",
        endpoint_environment_key="KIMI_BASE_URL",
    ),
)

AUTO_MODEL_ID = "auto"


def _create_model(raw: dict[str, object]) -> ModelDefinition:
    """把生成文件中的普通字典转换成类型明确的模型对象。"""

    return ModelDefinition(
        id=str(raw["id"]),
        provider=cast(ProviderId, raw["provider"]),
        model=str(raw["model"]),
        name=str(raw["name"]),
        description=str(raw["description"]),
        capabilities=tuple(str(item) for item in cast(list[object], raw["capabilities"])),
        chat_compatible=bool(raw.get("chatCompatible", True)),
        auto_select=bool(raw.get("autoSelect", True)),
        fallback_select=bool(raw.get("fallbackSelect", False)),
        auto_priority=int(cast(int, raw.get("autoPriority", 100))),
    )


MODELS: tuple[ModelDefinition, ...] = tuple(
    _create_model(raw) for raw in MODEL_CATALOG_DATA
)


def get_provider(provider_id: ProviderId) -> ProviderDefinition:
    """按供应商 ID 返回注册信息。"""

    for provider in PROVIDERS:
        if provider.id == provider_id:
            return provider
    raise ValueError(f"未注册的模型供应商：{provider_id}")


def get_model(model_id_or_name: str | None) -> ModelDefinition | None:
    """按逻辑 ID、旧版别名或厂商真实模型名查找模型。"""

    value = (model_id_or_name or "").strip()
    if not value or value == AUTO_MODEL_ID:
        return None
    normalized = MODEL_ID_ALIASES.get(value, value)
    for model in MODELS:
        if model.id == normalized or model.model == normalized:
            return model
    return None


def models_for_provider(provider_id: ProviderId) -> tuple[ModelDefinition, ...]:
    """返回指定供应商的全部聊天模型。"""

    return tuple(
        model
        for model in MODELS
        if model.provider == provider_id and model.chat_compatible
    )


def auto_models_for_provider(provider_id: ProviderId) -> tuple[ModelDefinition, ...]:
    """返回允许供应商级自动验证和降级的模型，按优先级排序。"""

    return tuple(
        sorted(
            (
                model
                for model in models_for_provider(provider_id)
                if model.auto_select or model.fallback_select
            ),
            key=lambda model: model.auto_priority,
        )
    )


def default_model_for_provider(provider_id: ProviderId) -> ModelDefinition:
    """返回指定供应商优先级最高的自动候选模型。"""

    candidates = auto_models_for_provider(provider_id)
    if candidates:
        return candidates[0]
    raise ValueError(f"供应商 {provider_id} 没有可自动选择的聊天模型")
