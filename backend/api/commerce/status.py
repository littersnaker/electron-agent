"""Commerce 数据源状态与轻量连通性检查。"""

from __future__ import annotations

from fastapi import Request

from backend.services.commerce.credentials import read_credentials, secret_fingerprint
from backend.services.commerce.marketplaces import get_marketplace
from backend.services.commerce.sources.ali1688 import search_1688
from backend.services.commerce.sources.tiktokshop import fetch_tiktok_access_token
from backend.services.commerce.talordata import CURRENT_ENDPOINT, request_search

SUPPORTED_HEALTH_PROVIDERS = {"talordata", "keepa", "tiktok", "temu", "1688"}


def read_data_source_status() -> dict[str, object]:
    """返回不包含密钥正文的数据源配置状态。"""

    credentials = read_credentials()
    providers = {
        "talordata": {
            "configured": bool(credentials.get("talordata")),
            "fingerprint": secret_fingerprint(credentials.get("talordata")),
        },
        "keepa": {
            "configured": bool(credentials.get("keepa")),
            "fingerprint": secret_fingerprint(credentials.get("keepa")),
        },
        "tiktok": {
            "configured": bool(
                credentials.get("tiktok_client_key")
                and credentials.get("tiktok_client_secret")
            )
        },
        "temu": {
            "configured": bool(
                credentials.get("temu_app_key")
                and credentials.get("temu_app_secret")
            )
        },
        "1688": {
            "configured": bool(
                credentials.get("alibaba_1688_app_key")
                and credentials.get("alibaba_1688_app_secret")
            )
        },
    }
    return {
        "environmentConfigured": providers["talordata"]["configured"],
        "environmentTokenFingerprint": providers["talordata"]["fingerprint"],
        "keepaConfigured": providers["keepa"]["configured"],
        "endpoint": CURRENT_ENDPOINT,
        "providers": providers,
    }


async def verify_data_source(request: Request) -> dict[str, object]:
    """按用户选择的数据源执行不会泄露凭证的轻量检查。"""

    try:
        body = await request.json()
    except ValueError:
        body = {}
    provider = body.get("provider") if isinstance(body, dict) else None
    if provider not in SUPPORTED_HEALTH_PROVIDERS:
        return {"ok": False, "state": "error", "message": "请选择需要验证的数据源。"}

    credentials = read_credentials(request)
    if provider == "keepa":
        return {
            "ok": bool(credentials.get("keepa")),
            "state": "configured" if credentials.get("keepa") else "unconfigured",
            "message": "Keepa 凭据已填写；当前未做真实 API 探测。",
        }
    if provider == "tiktok":
        client_key = credentials.get("tiktok_client_key")
        client_secret = credentials.get("tiktok_client_secret")
        if not (client_key and client_secret):
            return {
                "ok": False,
                "state": "unconfigured",
                "message": "缺少 TikTok Shop Client Key / Secret。",
            }
        try:
            await fetch_tiktok_access_token(client_key, client_secret)
            return {
                "ok": True,
                "state": "configured",
                "message": "TikTok Shop 令牌获取成功，网络连通。",
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "ok": False,
                "state": "failed",
                "message": f"TikTok Shop 探测失败：{exc}",
            }
    if provider == "1688":
        app_key = credentials.get("alibaba_1688_app_key")
        app_secret = credentials.get("alibaba_1688_app_secret")
        access_token = credentials.get("alibaba_1688_access_token")
        if not (app_key and app_secret):
            return {
                "ok": False,
                "state": "unconfigured",
                "message": "缺少 1688 App Key / Secret。",
            }
        try:
            await search_1688("probe", app_key, app_secret, access_token or "", limit=1)
            return {
                "ok": True,
                "state": "configured",
                "message": "1688 API 请求成功，网络连通。",
            }
        except Exception as exc:  # noqa: BLE001
            return {
                "ok": False,
                "state": "failed",
                "message": f"1688 探测失败：{exc}",
            }

    token = credentials.get("talordata")
    if not token:
        return {"ok": False, "state": "unconfigured", "message": "未检测到 TalorData Token。"}
    try:
        observations, diagnostic = await request_search(
            token,
            "amazon",
            get_marketplace("US"),
            "google",
            1,
        )
        if not observations:
            return {
                "ok": False,
                "state": "empty",
                "message": "连接成功，但没有解析到测试结果。",
                **diagnostic,
            }
        return {
            "ok": True,
            "state": "ready",
            "message": "TalorData 连接和结果解析正常。",
            **diagnostic,
        }
    except RuntimeError as exc:
        return {"ok": False, "state": "error", "message": str(exc)}
