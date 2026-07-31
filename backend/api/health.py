"""健康检查接口。"""

from __future__ import annotations

from fastapi import APIRouter

router = APIRouter(tags=["health"])


@router.get("/api/health")
async def health_check() -> dict[str, object]:
    """返回 Electron 用于判断 Python 服务是否启动成功的状态。"""

    return {"ok": True, "service": "multi-agent-fastapi", "version": 1}
