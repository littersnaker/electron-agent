"""LLM 供应商与模型注册表。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ProviderId = Literal["qwen", "openai", "gemini", "deepseek", "glm", "kimi"]


@dataclass(frozen=True, slots=True)
class ProviderDefinition:
    """描述一个模型供应商的鉴权方式和默认地址。"""

    id: ProviderId
    name: str
    environment_key: str
    request_header: str
    protocol: Literal["openai-compatible", "gemini"]
    default_endpoint: str | None = None


@dataclass(frozen=True, slots=True)
class ModelDefinition:
    """描述前端模型 ID 与厂商真实模型名的对应关系。"""

    id: str
    provider: ProviderId
    model: str
    name: str
    description: str
    capabilities: tuple[str, ...]
    chat_compatible: bool = True


PROVIDERS: tuple[ProviderDefinition, ...] = (
    ProviderDefinition(
        "qwen",
        "Qwen / DashScope",
        "DASHSCOPE_API_KEY",
        "x-llm-key-qwen",
        "openai-compatible",
        "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
    ),
    ProviderDefinition(
        "openai",
        "OpenAI",
        "OPENAI_API_KEY",
        "x-llm-key-openai",
        "openai-compatible",
        "https://api.openai.com/v1/chat/completions",
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
    ),
    ProviderDefinition(
        "glm",
        "GLM / BigModel",
        "GLM_API_KEY",
        "x-llm-key-glm",
        "openai-compatible",
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    ),
    ProviderDefinition(
        "kimi",
        "Kimi / Moonshot",
        "KIMI_API_KEY",
        "x-llm-key-kimi",
        "openai-compatible",
        "https://api.moonshot.cn/v1/chat/completions",
    ),
)

DEFAULT_MODEL_ID = "qwen:qwen3.7-max"
AUTO_MODEL_ID = "auto"
TEXT_CAPABILITIES = (
    "text",
    "stream",
    "tool_call",
    "reasoning",
    "coding",
    "long_context",
    "structured_output",
)

MODELS: tuple[ModelDefinition, ...] = (
    ModelDefinition(
        DEFAULT_MODEL_ID,
        "qwen",
        "qwen3.7-max",
        "Qwen 3.7 Max",
        "默认代码与复杂任务模型",
        TEXT_CAPABILITIES,
    ),
    ModelDefinition(
        "Qwen 3.7 Max Preview",
        "qwen",
        "7-max-27-max-2026-06-08",
        "Qwen 3.7 Max Preview",
        "复杂任务预览模型",
        TEXT_CAPABILITIES,
    ),
    ModelDefinition(
        "百炼 GLM-5.2",
        "qwen",
        "glm-5.2",
        "百炼 GLM-5.2",
        "百炼托管的 GLM 模型",
        TEXT_CAPABILITIES,
    ),
    ModelDefinition(
        "百炼 K2.7 Code",
        "qwen",
        "kimi-k2.7-code",
        "百炼 K2.7 Code",
        "百炼托管的代码模型",
        TEXT_CAPABILITIES,
    ),
    ModelDefinition(
        "百炼 V4 Pro",
        "qwen",
        "deepseek-v4-pro",
        "百炼 V4 Pro",
        "百炼托管的复杂推理模型",
        TEXT_CAPABILITIES,
    ),
    ModelDefinition(
        "qwen:qwen3.7-plus",
        "qwen",
        "qwen3.7-plus-2026-05-26",
        "Qwen 3.7 Plus",
        "快速问答与常规代码任务",
        TEXT_CAPABILITIES + ("fast",),
    ),
    ModelDefinition(
        "qwen:qwen-image-2.0-pro-2026-06-22",
        "qwen",
        "qwen-image-2.0-pro-2026-06-22",
        "Qwen VL Max",
        "界面截图与图片理解",
        ("text", "vision", "stream", "reasoning", "long_context"),
    ),
    ModelDefinition(
        "openai:gpt-5.1",
        "openai",
        "gpt-5.1",
        "OpenAI GPT-5.1",
        "规划、审查、代码和多模态任务",
        TEXT_CAPABILITIES + ("vision",),
    ),
    ModelDefinition(
        "gemini:gemini-3.6-flash",
        "gemini",
        "gemini-3.6-flash",
        "Gemini 3.6 Flash",
        "快速长上下文和多模态分析",
        TEXT_CAPABILITIES + ("vision", "fast"),
    ),
    ModelDefinition(
        "deepseek:deepseek-v4-pro",
        "deepseek",
        "deepseek-v4-pro",
        "DeepSeek V4 Pro",
        "复杂推理、代码修改和审查",
        TEXT_CAPABILITIES,
    ),
    ModelDefinition(
        "deepseek:deepseek-v4-flash",
        "deepseek",
        "deepseek-v4-flash",
        "DeepSeek V4 Flash",
        "低成本快速代码与分析任务",
        TEXT_CAPABILITIES + ("fast",),
    ),
    ModelDefinition(
        "glm:glm-4.7",
        "glm",
        "glm-4.7",
        "GLM 4.7",
        "中文代码、推理和长上下文任务",
        TEXT_CAPABILITIES,
    ),
    ModelDefinition(
        "glm:glm-4.6v",
        "glm",
        "glm-4.6v",
        "GLM 4.6V",
        "视觉编程和图文任务",
        TEXT_CAPABILITIES + ("vision",),
    ),
    ModelDefinition(
        "kimi:kimi-k2.5",
        "kimi",
        "kimi-k3",
        "Kimi K3",
        "长上下文、多模态和复杂任务",
        TEXT_CAPABILITIES + ("vision",),
    ),
    ModelDefinition(
        "kimi:kimi-k2.6",
        "kimi",
        "kimi-k2.6",
        "Kimi K2.6",
        "长上下文、多模态和复杂任务",
        TEXT_CAPABILITIES + ("vision",),
    ),
)


def get_provider(provider_id: ProviderId) -> ProviderDefinition:
    """按供应商 ID 返回注册信息。"""

    for provider in PROVIDERS:
        if provider.id == provider_id:
            return provider
    raise ValueError(f"未注册的模型供应商：{provider_id}")


def get_model(model_id_or_name: str | None) -> ModelDefinition | None:
    """按前端模型 ID 或厂商模型名查找模型。"""

    value = (model_id_or_name or "").strip()
    if not value or value == AUTO_MODEL_ID:
        return None
    for model in MODELS:
        if model.id == value or model.model == value:
            return model
    return None


def default_model_for_provider(provider_id: ProviderId) -> ModelDefinition:
    """返回指定供应商的第一个可聊天模型。"""

    for model in MODELS:
        if model.provider == provider_id and model.chat_compatible:
            return model
    raise ValueError(f"供应商 {provider_id} 没有可聊天模型")
