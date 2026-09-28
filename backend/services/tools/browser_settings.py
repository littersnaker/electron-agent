"""浏览器自动化设置：存储于 SQLite app_preferences，供设置界面与执行闸门共用。"""

from __future__ import annotations

from dataclasses import dataclass

from backend.services.workspace.database import dumps_json, loads_json, open_database, utc_now_iso

BROWSER_SETTINGS_KEY = "agent.browser"


@dataclass(slots=True)
class BrowserSettings:
    """浏览器自动化工具的可配置项。"""

    enabled: bool = True

    def to_json(self) -> dict[str, object]:
        """转换为前端可读的 JSON（无敏感字段）。"""
        return {"enabled": self.enabled}


async def read_browser_settings() -> BrowserSettings:
    """读取浏览器自动化设置；无记录或内容损坏时返回默认值（允许）。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT value_json FROM app_preferences WHERE key = ?",
            (BROWSER_SETTINGS_KEY,),
        )
        row = await cursor.fetchone()
    if not row:
        return BrowserSettings()
    payload = loads_json(row["value_json"], None)
    if not isinstance(payload, dict):
        return BrowserSettings()
    return BrowserSettings(enabled=bool(payload.get("enabled", True)))


async def write_browser_settings(settings: BrowserSettings) -> BrowserSettings:
    """写入浏览器自动化设置。"""

    async with open_database() as connection:
        await connection.execute(
            "INSERT INTO app_preferences (key, value_json, updated_at) "
            "VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET "
            "value_json = excluded.value_json, updated_at = excluded.updated_at",
            (BROWSER_SETTINGS_KEY, dumps_json({"enabled": settings.enabled}), utc_now_iso()),
        )
    return settings
