"""应用偏好设置的 SQLite 读写逻辑。"""

from __future__ import annotations

from backend.schemas.preferences import ThemeMode
from backend.services.workspace.database import (
    dumps_json,
    loads_json,
    open_database,
    utc_now_iso,
)

THEME_PREFERENCE_KEY = "appearance.theme"


async def read_theme_preference() -> ThemeMode | None:
    """读取保存的深浅色主题；无记录或内容损坏时返回 ``None``。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT value_json FROM app_preferences WHERE key = ?",
            (THEME_PREFERENCE_KEY,),
        )
        row = await cursor.fetchone()

    if not row:
        return None
    value = loads_json(row["value_json"], None)
    return value if value in {"dark", "light"} else None


async def write_theme_preference(theme: ThemeMode) -> ThemeMode:
    """写入界面主题，并返回已经保存的规范化值。"""

    async with open_database() as connection:
        await connection.execute(
            "INSERT INTO app_preferences (key, value_json, updated_at) "
            "VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET "
            "value_json = excluded.value_json, updated_at = excluded.updated_at",
            (THEME_PREFERENCE_KEY, dumps_json(theme), utc_now_iso()),
        )
    return theme
