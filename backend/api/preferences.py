"""桌面应用偏好设置接口。"""

from __future__ import annotations

from fastapi import APIRouter

from backend.schemas.preferences import ThemePreferenceUpdate
from backend.services.workspace.preferences import (
    read_theme_preference,
    write_theme_preference,
)


router = APIRouter(prefix="/api/preferences", tags=["preferences"])


@router.get("/theme")
async def get_theme_preference() -> dict[str, str | None]:
    """返回 SQLite 中保存的界面主题。"""

    return {"theme": await read_theme_preference()}


@router.put("/theme")
async def put_theme_preference(body: ThemePreferenceUpdate) -> dict[str, str]:
    """把用户选择的深浅色主题写入 SQLite。"""

    theme = await write_theme_preference(body.theme)
    return {"theme": theme}
