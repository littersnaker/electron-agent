"""集中注册所有 FastAPI 业务路由。"""

from __future__ import annotations

from fastapi import APIRouter

from backend.api.chat import router as chat_router
from backend.api.commerce import router as commerce_router
from backend.api.health import router as health_router
from backend.api.mcp import router as mcp_router
from backend.api.media import router as media_router
from backend.api.legacy import router as legacy_router
from backend.api.models import router as models_router
from backend.api.observability import router as observability_router
from backend.api.qa import router as qa_router
from backend.api.workspace import router as workspace_router


api_router = APIRouter()


def register_routes() -> None:
    """把每个领域模块的路由注册到统一入口。"""

    for router in (
        health_router,
        models_router,
        workspace_router,
        qa_router,
        chat_router,
        media_router,
        commerce_router,
        observability_router,
        mcp_router,
        legacy_router,
    ):
        api_router.include_router(router)


register_routes()
