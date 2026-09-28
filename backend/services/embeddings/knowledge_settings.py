"""知识库 Jina Key 的后端持久化：存于 SQLite app_preferences。

用途：让 30 秒轮询 watcher 和上传后的后台索引在没有请求头的情况下也能拿到
Key（请求头只在上传/重建那一刻存在）。Key 明文存本地 SQLite，与 .env.local
的安全等级一致；任何接口都不会把 Key 原文返回给前端。
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.services.workspace.database import dumps_json, loads_json, open_database, utc_now_iso

JINA_KEY_PREFERENCE_KEY = "knowledge.jina"


@dataclass(slots=True)
class KnowledgeKeySettings:
    """知识库 Key 的持久化载荷。"""

    api_key: str = ""

    def to_json(self) -> dict[str, object]:
        # 永不返回 Key 原文，只返回是否已配置。
        """转换为前端可读的 JSON；永不返回 Key 原文。"""
        return {"hasKey": bool(self.api_key)}


async def read_jina_api_key() -> str:
    """读取持久化的 Jina Key；无记录时返回空串。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT value_json FROM app_preferences WHERE key = ?",
            (JINA_KEY_PREFERENCE_KEY,),
        )
        row = await cursor.fetchone()
    if not row:
        return ""
    payload = loads_json(row["value_json"], None)
    if not isinstance(payload, dict):
        return ""
    return str(payload.get("apiKey") or "").strip()


async def write_jina_api_key(api_key: str) -> KnowledgeKeySettings:
    """写入（或清空）持久化的 Jina Key。"""

    normalized = api_key.strip()
    async with open_database() as connection:
        await connection.execute(
            "INSERT INTO app_preferences (key, value_json, updated_at) "
            "VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET "
            "value_json = excluded.value_json, updated_at = excluded.updated_at",
            (JINA_KEY_PREFERENCE_KEY, dumps_json({"apiKey": normalized}), utc_now_iso()),
        )
    return KnowledgeKeySettings(api_key=normalized)
