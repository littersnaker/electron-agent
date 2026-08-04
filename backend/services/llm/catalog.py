"""LLM 供应商与模型注册表。

全部从 ``config/*.json`` 运行时读取：providers.json 供应商、
chat-models.json 聊天模型。改 JSON 后重启/重新构建即生效，不再需要生成脚本。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal, cast

CONFIG_DIR = Path(__file__).resolve().parents[3] / "config"


def _read_config(filename: str) -> dict:
    """读取配置 JSON；缺失或损坏时快速失败，避免静默使用空注册表。"""

    path = CONFIG_DIR / filename
    try:
        payload = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise RuntimeError(f"模型配置文件缺失或损坏：{path}（{exc}）") from exc
    return payload if isinstance(payload, dict) else {}


ProviderId = Literal[
    "qwen",
    "openai",
    "gemini",
    "deepseek",
    "glm",
    "kimi",
    "doubao",
]
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


def _load_providers() -> (
    tuple[
        tuple[ProviderDefinition, ...],
        dict[ProviderId, tuple[str, ...]],
    ]
):
    """从 providers.json 加载供应商及其环境变量别名。"""

    payload = _read_config("providers.json")
    providers: list[ProviderDefinition] = []
    env_keys: dict[ProviderId, tuple[str, ...]] = {}
    for entry in payload.get("providers") or []:
        if not isinstance(entry, dict):
            continue
        provider_id = cast(ProviderId, str(entry.get("id") or ""))
        keys = tuple(str(item) for item in (entry.get("environmentKeys") or []))
        env_keys[provider_id] = keys
        providers.append(
            ProviderDefinition(
                id=provider_id,
                name=str(entry.get("name") or provider_id),
                environment_key=keys[0] if keys else "",
                request_header=str(entry.get("requestHeader") or ""),
                protocol=cast(
                    Protocol,
                    str(entry.get("protocol") or "openai-compatible"),
                ),
                default_endpoint=str(entry.get("defaultEndpoint") or "") or None,
                fallback_endpoints=tuple(
                    str(item) for item in (entry.get("fallbackEndpoints") or [])
                ),
                endpoint_environment_key=str(
                    entry.get("endpointEnvironmentKey") or ""
                )
                or None,
            )
        )
    return tuple(providers), env_keys


PROVIDERS, PROVIDER_ENV_KEYS = _load_providers()

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


def _load_chat_models() -> (
    tuple[tuple[ModelDefinition, ...], dict[str, str], str]
):
    """从 chat-models.json 加载聊天模型、别名与默认模型 ID。"""

    payload = _read_config("chat-models.json")
    raw_models = payload.get("models") or []
    models = tuple(
        _create_model(raw)
        for raw in raw_models
        if isinstance(raw, dict)
    )
    aliases = {
        str(key): str(value)
        for key, value in dict(payload.get("aliases") or {}).items()
    }
    default_id = str(payload.get("defaultModelId") or "")
    return models, aliases, default_id


MODELS, MODEL_ID_ALIASES, DEFAULT_MODEL_ID = _load_chat_models()


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
