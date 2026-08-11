"""跨境电商外部数据源凭据读取工具。"""

from __future__ import annotations

import hashlib
import os

from fastapi import Request

HEADER_TO_FIELD = {
    "x-commerce-talordata-token": "talordata",
    "x-commerce-keepa-key": "keepa",
    "x-commerce-amazon-client-id": "amazon_client_id",
    "x-commerce-amazon-client-secret": "amazon_client_secret",
    "x-commerce-amazon-refresh-token": "amazon_refresh_token",
    "x-commerce-tiktok-client-key": "tiktok_client_key",
    "x-commerce-tiktok-client-secret": "tiktok_client_secret",
    "x-commerce-tiktok-merchant-id": "tiktok_merchant_id",
    "x-commerce-temu-app-key": "temu_app_key",
    "x-commerce-temu-app-secret": "temu_app_secret",
    "x-commerce-temu-access-token": "temu_access_token",
    "x-commerce-1688-app-key": "alibaba_1688_app_key",
    "x-commerce-1688-app-secret": "alibaba_1688_app_secret",
    "x-commerce-1688-access-token": "alibaba_1688_access_token",
}

ENVIRONMENT_FIELDS = {
    "talordata": ("TALORDATA_API_TOKEN", "SERPAPI_API_KEY"),
    "keepa": ("KEEPA_API_KEY",),
    "amazon_client_id": ("AMAZON_SP_API_CLIENT_ID",),
    "amazon_client_secret": ("AMAZON_SP_API_CLIENT_SECRET",),
    "amazon_refresh_token": ("AMAZON_SP_API_REFRESH_TOKEN",),
    "tiktok_client_key": ("TIKTOK_SHOP_CLIENT_KEY",),
    "tiktok_client_secret": ("TIKTOK_SHOP_CLIENT_SECRET",),
    "tiktok_merchant_id": ("TIKTOK_SHOP_MERCHANT_ID",),
    "temu_app_key": ("TEMU_APP_KEY",),
    "temu_app_secret": ("TEMU_APP_SECRET",),
    "temu_access_token": ("TEMU_ACCESS_TOKEN",),
    "alibaba_1688_app_key": ("ALIBABA_1688_APP_KEY",),
    "alibaba_1688_app_secret": ("ALIBABA_1688_APP_SECRET",),
    "alibaba_1688_access_token": ("ALIBABA_1688_ACCESS_TOKEN",),
}


def normalize_token(value: str | None) -> str | None:
    """清理用户可能一起粘贴的变量名、引号和 ``Bearer`` 前缀。"""

    if not value:
        return None
    token = value.strip()
    for prefix in ("TALORDATA_API_TOKEN=", "SERPAPI_API_KEY=", "Bearer "):
        if token.lower().startswith(prefix.lower()):
            token = token[len(prefix) :].strip()
    token = token.strip("\"'").strip()
    return token or None


def read_credentials(request: Request | None = None) -> dict[str, str]:
    """合并环境变量和当前请求头中的电商数据源凭据。

    环境变量作为默认值；设置面板通过请求头传来的非空值拥有更高优先级。
    返回值只在后端内存中使用，绝不会直接回传给浏览器。
    """

    credentials: dict[str, str] = {}
    for field, environment_names in ENVIRONMENT_FIELDS.items():
        for name in environment_names:
            value = normalize_token(os.getenv(name))
            if value:
                credentials[field] = value
                break

    if request is not None:
        for header, field in HEADER_TO_FIELD.items():
            value = normalize_token(request.headers.get(header))
            if value:
                credentials[field] = value
    return credentials


def secret_fingerprint(value: str | None) -> str | None:
    """生成不可逆的短指纹，让界面判断配置是否变化而不暴露密钥。"""

    normalized = normalize_token(value)
    if not normalized:
        return None
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:10]
