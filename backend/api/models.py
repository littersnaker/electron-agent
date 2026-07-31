"""公开模型与供应商配置接口。"""

from __future__ import annotations

from fastapi import APIRouter

from backend.services.llm.catalog import MODELS
from backend.services.llm.credentials import public_provider_status
from backend.services.media.catalog import MEDIA_MODELS

router = APIRouter(tags=["models"])


def _model_payload() -> list[dict[str, object]]:
    """把 Python 模型注册表转换成与原前端兼容的 JSON。"""

    return [
        {
            "id": model.id,
            "provider": model.provider,
            "name": model.name,
            "description": model.description,
            "capabilities": list(model.capabilities),
            "chatCompatible": model.chat_compatible,
        }
        for model in MODELS
    ]


@router.get("/api/config")
async def get_public_config() -> dict[str, object]:
    """返回供应商配置状态和文本模型目录，不返回任何密钥。"""

    return {"providers": public_provider_status(), "models": _model_payload()}


@router.get("/api/models")
async def get_models() -> dict[str, object]:
    """返回文本模型和媒体模型目录。"""

    return {
        "providers": public_provider_status(),
        "models": _model_payload(),
        "mediaModels": MEDIA_MODELS,
    }
