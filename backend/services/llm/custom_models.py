"""SQLite 自定义聊天模型仓储与运行时缓存。

缓存只保存模型元数据，不保存 API Key。CRUD 每次成功后都会同步更新内存缓存，
因此新增模型无需重启 Python，下一次聊天请求即可生效。
"""

from __future__ import annotations

from dataclasses import dataclass
from uuid import uuid4

from backend.schemas.custom_models import CustomModelInput
from backend.services.llm.catalog import ModelDefinition, ProviderId
from backend.services.workspace.database import open_database, utc_now_iso


@dataclass(frozen=True, slots=True)
class CustomModelRow:
    """数据库记录的强类型表示。"""

    id: str
    name: str
    provider: ProviderId
    model: str
    base_url: str | None
    include_in_auto: bool
    auto_priority: int
    supports_vision: bool
    created_at: str
    updated_at: str


_CACHE: dict[str, CustomModelRow] = {}


def _to_definition(row: CustomModelRow) -> ModelDefinition:
    """把 SQLite 记录转换成 LLM Gateway 可直接调用的模型定义。"""

    capabilities = ["text", "stream"]
    if row.supports_vision:
        capabilities.append("vision")
    return ModelDefinition(
        id=row.id,
        provider=row.provider,
        model=row.model,
        name=row.name,
        description="用户添加的自定义模型",
        capabilities=tuple(capabilities),
        chat_compatible=True,
        auto_select=row.include_in_auto,
        fallback_select=False,
        auto_priority=row.auto_priority,
        base_url=row.base_url,
        is_custom=True,
    )


def _row_from_sqlite(row: object) -> CustomModelRow:
    """把 sqlite3.Row 转换成缓存记录。"""

    values = row  # sqlite3.Row 支持字符串下标，保留局部变量便于类型检查。
    return CustomModelRow(
        id=str(values["id"]),  # type: ignore[index]
        name=str(values["name"]),  # type: ignore[index]
        provider=str(values["provider"]),  # type: ignore[index,arg-type]
        model=str(values["model"]),  # type: ignore[index]
        base_url=str(values["base_url"]) if values["base_url"] else None,  # type: ignore[index]
        include_in_auto=bool(values["include_in_auto"]),  # type: ignore[index]
        auto_priority=int(values["auto_priority"]),  # type: ignore[index]
        supports_vision=bool(values["supports_vision"]),  # type: ignore[index]
        created_at=str(values["created_at"]),  # type: ignore[index]
        updated_at=str(values["updated_at"]),  # type: ignore[index]
    )


def _payload(row: CustomModelRow) -> dict[str, object]:
    """把缓存记录转换成前端 JSON 字段。"""

    return {
        "id": row.id,
        "name": row.name,
        "provider": row.provider,
        "model": row.model,
        "baseUrl": row.base_url,
        "includeInAuto": row.include_in_auto,
        "autoPriority": row.auto_priority,
        "supportsVision": row.supports_vision,
        "createdAt": row.created_at,
        "updatedAt": row.updated_at,
    }


async def initialize_custom_models() -> None:
    """从 SQLite 加载全部自定义模型，供启动后的同步路由读取。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT id, name, provider, model, base_url, include_in_auto, "
            "auto_priority, supports_vision, created_at, updated_at "
            "FROM custom_models ORDER BY auto_priority, created_at"
        )
        rows = await cursor.fetchall()
    _CACHE.clear()
    _CACHE.update((item.id, item) for item in map(_row_from_sqlite, rows))


def list_custom_model_definitions() -> tuple[ModelDefinition, ...]:
    """返回当前运行时全部自定义模型定义。"""

    rows = sorted(_CACHE.values(), key=lambda item: (item.auto_priority, item.created_at))
    return tuple(_to_definition(row) for row in rows)


def get_custom_model_definition(model_id: str) -> ModelDefinition | None:
    """按稳定 ID 返回自定义模型；不存在时返回 ``None``。"""

    row = _CACHE.get(model_id)
    return _to_definition(row) if row else None


async def list_custom_models() -> list[dict[str, object]]:
    """返回自定义模型列表。"""

    rows = sorted(_CACHE.values(), key=lambda item: (item.auto_priority, item.created_at))
    return [_payload(row) for row in rows]


async def create_custom_model(body: CustomModelInput) -> dict[str, object]:
    """创建自定义模型并立即写入运行时缓存。"""

    now = utc_now_iso()
    row = CustomModelRow(
        id=f"custom:{uuid4().hex}",
        name=body.name,
        provider=body.provider,
        model=body.model,
        base_url=body.base_url,
        include_in_auto=body.include_in_auto,
        auto_priority=body.auto_priority,
        supports_vision=body.supports_vision,
        created_at=now,
        updated_at=now,
    )
    async with open_database() as connection:
        await connection.execute(
            "INSERT INTO custom_models (id, name, provider, model, base_url, "
            "include_in_auto, auto_priority, supports_vision, created_at, updated_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                row.id,
                row.name,
                row.provider,
                row.model,
                row.base_url,
                int(row.include_in_auto),
                row.auto_priority,
                int(row.supports_vision),
                row.created_at,
                row.updated_at,
            ),
        )
    _CACHE[row.id] = row
    return _payload(row)


async def update_custom_model(
    model_id: str,
    body: CustomModelInput,
) -> dict[str, object] | None:
    """修改模型元数据，但保持稳定 ID 与原创建时间不变。"""

    current = _CACHE.get(model_id)
    if not current:
        return None
    row = CustomModelRow(
        id=current.id,
        name=body.name,
        provider=body.provider,
        model=body.model,
        base_url=body.base_url,
        include_in_auto=body.include_in_auto,
        auto_priority=body.auto_priority,
        supports_vision=body.supports_vision,
        created_at=current.created_at,
        updated_at=utc_now_iso(),
    )
    async with open_database() as connection:
        await connection.execute(
            "UPDATE custom_models SET name = ?, provider = ?, model = ?, "
            "base_url = ?, include_in_auto = ?, auto_priority = ?, "
            "supports_vision = ?, updated_at = ? WHERE id = ?",
            (
                row.name,
                row.provider,
                row.model,
                row.base_url,
                int(row.include_in_auto),
                row.auto_priority,
                int(row.supports_vision),
                row.updated_at,
                row.id,
            ),
        )
    _CACHE[row.id] = row
    return _payload(row)


async def delete_custom_model(model_id: str) -> bool:
    """删除 SQLite 记录并同步移除运行时缓存。"""

    if model_id not in _CACHE:
        return False
    async with open_database() as connection:
        await connection.execute("DELETE FROM custom_models WHERE id = ?", (model_id,))
    _CACHE.pop(model_id, None)
    return True
