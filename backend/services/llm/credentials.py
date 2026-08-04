"""从请求头、运行环境和 Python 内置兜底中解析模型凭证。"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Literal

from fastapi import Request

from backend.core.builtin_credentials import get_builtin_value, has_builtin_value
from backend.services.llm.catalog import (
    PROVIDER_ENV_KEYS,
    PROVIDERS,
    ProviderId,
)


ENVIRONMENT_ALIASES: dict[ProviderId, tuple[str, ...]] = PROVIDER_ENV_KEYS

# 当前只允许百炼使用随 Python 后端分发的共享兜底 Key。其他供应商仍要求用户
# 自己配置，避免无意中把更多第三方密钥打进桌面安装包。
BUILTIN_VARIABLES: dict[ProviderId, str] = {
    "qwen": "DASHSCOPE_API_KEY",
}

CredentialSource = Literal["user", "environment", "builtin"]


@dataclass(frozen=True, slots=True)
class LlmCredentials:
    """保存本次请求可用的 API Key 及其来源。"""

    values: dict[ProviderId, str]
    sources: dict[ProviderId, CredentialSource] = field(default_factory=dict)
    endpoints: dict[ProviderId, str] = field(default_factory=dict)

    def get(self, provider_id: ProviderId) -> str | None:
        """读取指定供应商的 Key；未配置时返回 ``None``。"""

        value = self.values.get(provider_id, "").strip()
        return value or None

    def source(self, provider_id: ProviderId) -> CredentialSource | None:
        """返回凭证来源，便于界面解释是否正在使用内置兜底。"""

        return self.sources.get(provider_id)

    def get_endpoint(self, provider_id: ProviderId) -> str | None:
        """读取用户在桌面设置中填写的供应商 Base URL。"""

        value = self.endpoints.get(provider_id, "").strip()
        return value or None


def _environment_key(provider_id: ProviderId) -> str:
    """按兼容顺序返回某个模型供应商的第一个非空环境变量。"""

    for variable_name in ENVIRONMENT_ALIASES[provider_id]:
        value = os.getenv(variable_name, "").strip()
        if value:
            return value
    return ""


def _builtin_key(provider_id: ProviderId) -> str:
    """返回允许随 Python 分发的内置兜底 Key。"""

    variable_name = BUILTIN_VARIABLES.get(provider_id)
    return get_builtin_value(variable_name) if variable_name else ""


def _resolve_provider_credential(
    request: Request,
    provider_id: ProviderId,
) -> tuple[str, CredentialSource | None]:
    """按用户 Key、环境变量、内置兜底的顺序解析单个供应商凭证。"""

    provider = next(item for item in PROVIDERS if item.id == provider_id)
    request_value = request.headers.get(provider.request_header, "").strip()
    if request_value:
        return request_value, "user"

    environment_value = _environment_key(provider_id)
    if environment_value:
        return environment_value, "environment"

    builtin_value = _builtin_key(provider_id)
    if builtin_value:
        return builtin_value, "builtin"
    return "", None


def _request_endpoint(request: Request, provider_id: ProviderId) -> str:
    """读取前端传入的 Base URL，仅接受 HTTP(S) 地址。"""

    value = request.headers.get(f"x-llm-base-url-{provider_id}", "").strip()
    if not value:
        return ""
    if not value.startswith(("https://", "http://")):
        # 兼容配置错误：把 API Key 填进 Base URL 时忽略该覆盖，回退默认端点，
        # 避免出现 “unknown url type” 这类难排查的报错。
        return ""
    return value


def resolve_provider_key(request: Request, provider_id: ProviderId) -> str:
    """解析单个供应商 Key，供聊天以外的百炼媒体接口复用。"""

    value, _source = _resolve_provider_credential(request, provider_id)
    return value


def resolve_credentials(request: Request) -> LlmCredentials:
    """解析全部供应商凭证，并保留每个值的来源。"""

    values: dict[ProviderId, str] = {}
    sources: dict[ProviderId, CredentialSource] = {}
    endpoints: dict[ProviderId, str] = {}
    for provider in PROVIDERS:
        value, source = _resolve_provider_credential(request, provider.id)
        if value:
            values[provider.id] = value
        if source:
            sources[provider.id] = source
        endpoint = _request_endpoint(request, provider.id)
        if endpoint:
            endpoints[provider.id] = endpoint
    return LlmCredentials(values, sources, endpoints)


def public_provider_status() -> dict[str, dict[str, object]]:
    """返回不包含密钥内容的供应商配置状态。"""

    status: dict[str, dict[str, object]] = {}
    for provider in PROVIDERS:
        has_environment_key = bool(_environment_key(provider.id))
        builtin_variable = BUILTIN_VARIABLES.get(provider.id)
        has_builtin_fallback = bool(
            builtin_variable and has_builtin_value(builtin_variable)
        )
        status[provider.id] = {
            "name": provider.name,
            "environmentKey": provider.environment_key,
            "hasDefaultKey": has_environment_key or has_builtin_fallback,
            "hasEnvironmentKey": has_environment_key,
            "hasBuiltinFallback": has_builtin_fallback,
            "defaultCredentialSource": (
                "environment"
                if has_environment_key
                else "builtin"
                if has_builtin_fallback
                else None
            ),
        }
    return status
