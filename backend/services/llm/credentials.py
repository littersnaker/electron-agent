"""从请求头和环境变量中解析模型凭证。"""

from __future__ import annotations

import os
from dataclasses import dataclass

from fastapi import Request

from backend.services.llm.catalog import PROVIDERS, ProviderId


ENVIRONMENT_ALIASES: dict[ProviderId, tuple[str, ...]] = {
    "qwen": ("DASHSCOPE_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY", "NEXT_PUBLIC_GEMINI_API_KEY"),
    "deepseek": ("DEEPSEEK_API_KEY",),
    "glm": ("GLM_API_KEY", "ZHIPU_API_KEY"),
    "kimi": ("KIMI_API_KEY", "MOONSHOT_API_KEY"),
}


@dataclass(frozen=True, slots=True)
class LlmCredentials:
    """按供应商保存本次请求可用的 API Key。"""

    values: dict[ProviderId, str]

    def get(self, provider_id: ProviderId) -> str | None:
        """读取指定供应商的 Key；未配置时返回 ``None``。"""

        value = self.values.get(provider_id, "").strip()
        return value or None


def _environment_key(provider_id: ProviderId) -> str:
    """按兼容顺序返回某个模型供应商的第一个非空环境变量。"""

    for variable_name in ENVIRONMENT_ALIASES[provider_id]:
        value = os.getenv(variable_name, "").strip()
        if value:
            return value
    return ""


def resolve_credentials(request: Request) -> LlmCredentials:
    """优先使用前端本地 Key，再回退到后端环境变量。"""

    values: dict[ProviderId, str] = {}
    for provider in PROVIDERS:
        request_value = request.headers.get(provider.request_header, "").strip()
        value = request_value or _environment_key(provider.id)
        if value:
            values[provider.id] = value
    return LlmCredentials(values)


def public_provider_status() -> dict[str, dict[str, object]]:
    """返回不包含密钥内容的供应商配置状态。"""

    return {
        provider.id: {
            "name": provider.name,
            "environmentKey": provider.environment_key,
            "hasDefaultKey": bool(_environment_key(provider.id)),
        }
        for provider in PROVIDERS
    }
