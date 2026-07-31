"""跨境电商市场研究、Listing 和数据源状态接口。"""

from __future__ import annotations

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from backend.schemas.commerce import CommerceRequest
from backend.services.commerce.credentials import read_credentials, secret_fingerprint
from backend.services.commerce.listing import stream_listing
from backend.services.commerce.service import stream_research
from backend.services.commerce.talordata import CURRENT_ENDPOINT, request_search
from backend.services.commerce.marketplaces import get_marketplace


router = APIRouter(tags=["commerce"])
SUPPORTED_HEALTH_PROVIDERS = {"talordata", "keepa", "tiktok", "temu", "1688"}


@router.post("/api/commerce/research")
async def commerce_research(body: CommerceRequest, request: Request) -> StreamingResponse:
    """启动市场研究 SSE 流。"""

    credentials = read_credentials(request)
    return StreamingResponse(
        stream_research(body, credentials),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/api/commerce/listing")
async def commerce_listing(body: CommerceRequest) -> StreamingResponse:
    """启动安全的 Amazon Listing Demo SSE 流。"""

    return StreamingResponse(
        stream_listing(body),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/api/commerce/data-source/status")
async def commerce_data_source_status() -> dict[str, object]:
    """返回不含密钥的数据源配置元数据。"""

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
        "tiktok": {"configured": bool(credentials.get("tiktok_client_key") and credentials.get("tiktok_client_secret"))},
        "temu": {"configured": bool(credentials.get("temu_app_key") and credentials.get("temu_app_secret"))},
        "1688": {"configured": bool(credentials.get("alibaba_1688_app_key") and credentials.get("alibaba_1688_app_secret"))},
    }
    return {
        "environmentConfigured": providers["talordata"]["configured"],
        "environmentTokenFingerprint": providers["talordata"]["fingerprint"],
        "keepaConfigured": providers["keepa"]["configured"],
        "endpoint": CURRENT_ENDPOINT,
        "providers": providers,
    }


@router.post("/api/commerce/data-source/status")
async def verify_commerce_data_source(request: Request) -> dict[str, object]:
    """在用户主动点击验证时执行对应数据源的轻量健康检查。"""

    try:
        body = await request.json()
    except ValueError:
        body = {}
    provider = body.get("provider") if isinstance(body, dict) else None
    if provider not in SUPPORTED_HEALTH_PROVIDERS:
        return {"ok": False, "state": "error", "message": "请选择需要验证的数据源。"}

    credentials = read_credentials(request)
    if provider != "talordata":
        configured_fields = {
            "keepa": ("keepa",),
            "tiktok": ("tiktok_client_key", "tiktok_client_secret"),
            "temu": ("temu_app_key", "temu_app_secret"),
            "1688": ("alibaba_1688_app_key", "alibaba_1688_app_secret"),
        }[provider]
        configured = all(credentials.get(field) for field in configured_fields)
        return {
            "ok": configured,
            "state": "configured" if configured else "unconfigured",
            "message": "凭据字段已填写；Python 迁移版暂未执行该平台的真实网络验证。" if configured else "缺少必要凭据。",
        }

    token = credentials.get("talordata")
    if not token:
        return {"ok": False, "state": "unconfigured", "message": "未检测到 TalorData Token。"}
    try:
        observations, diagnostic = await request_search(
            token, "amazon", get_marketplace("US"), "google", 1
        )
        if not observations:
            return {"ok": False, "state": "empty", "message": "连接成功，但没有解析到测试结果。", **diagnostic}
        return {"ok": True, "state": "ready", "message": "TalorData 连接和结果解析正常。", **diagnostic}
    except RuntimeError as exc:
        return {"ok": False, "state": "error", "message": str(exc)}
