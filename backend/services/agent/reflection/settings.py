"""复盘循环的设置：存储于 SQLite app_preferences。"""

from __future__ import annotations

from dataclasses import dataclass

from backend.services.llm.catalog import get_model
from backend.services.llm.custom_models import get_custom_model_definition
from backend.services.workspace.database import (
    dumps_json,
    loads_json,
    open_database,
    utc_now_iso,
)

REVIEW_SETTINGS_KEY = "agent.review"
DEFAULT_REVIEW_MODEL_ID = "deepseek:deepseek-v4-flash"


@dataclass(slots=True)
class ReviewSettings:
    """复盘循环的可配置项（前端入口填写）。"""

    model_id: str = DEFAULT_REVIEW_MODEL_ID
    enabled: bool = True

    def to_json(self) -> dict[str, object]:
        model = resolve_review_model(self.model_id)
        display = model.model if model is not None else self.model_id
        return {"modelId": display, "enabled": self.enabled}


def _normalize_model_id(model_id: str) -> str:
    """把用户输入的模型名规范化为稳定 ID（provider:model）。

    用户只需填模型名（如 deepseek-v4-flash），厂商由目录自动解析；
    同名模型需要区分时仍可用 provider:model 完整格式。
    """

    value = (model_id or "").strip()
    if not value:
        return DEFAULT_REVIEW_MODEL_ID
    if ":" in value:
        # 完整格式 provider:model，精确解析。
        resolved = get_custom_model_definition(value) or get_model(value)
        if resolved is None:
            raise ValueError(f"未知的复盘模型：{value}")
        return resolved.id
    # 裸模型名：全量匹配，多厂商同名时优先"原生厂商"
    # （模型名前缀与 provider 一致），避免 deepseek-v4-pro 被解析成百炼托管版本。
    matches = [
        model
        for model in _all_catalog_models()
        if model.model == value or model.id == value
    ]
    if not matches:
        raise ValueError(
            f"未知的复盘模型：{value}（请填模型名，如 deepseek-v4-flash）"
        )
    resolved = next(
        (model for model in matches if model.provider == value.split("-")[0]),
        matches[0],
    )
    return resolved.id


def _all_catalog_models() -> tuple:
    """合并内置目录与自定义模型，供裸模型名解析。"""

    from backend.services.llm.catalog import MODELS
    from backend.services.llm.custom_models import (
        list_custom_model_definitions,
    )

    return (*list_custom_model_definitions(), *MODELS)


async def read_review_settings() -> ReviewSettings:
    """读取复盘设置；无记录或内容损坏时返回默认值。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT value_json FROM app_preferences WHERE key = ?",
            (REVIEW_SETTINGS_KEY,),
        )
        row = await cursor.fetchone()
    if not row:
        return ReviewSettings()
    payload = loads_json(row["value_json"], None)
    if not isinstance(payload, dict):
        return ReviewSettings()
    model_id = str(payload.get("modelId") or DEFAULT_REVIEW_MODEL_ID)
    enabled = bool(payload.get("enabled", True))
    try:
        model_id = _normalize_model_id(model_id)
    except ValueError:
        model_id = DEFAULT_REVIEW_MODEL_ID
    return ReviewSettings(model_id=model_id, enabled=enabled)


async def write_review_settings(settings: ReviewSettings) -> ReviewSettings:
    """写入复盘设置（存储规范 provider:model，对外接口展示裸模型名）。"""

    normalized = ReviewSettings(
        model_id=_normalize_model_id(settings.model_id),
        enabled=settings.enabled,
    )
    async with open_database() as connection:
        await connection.execute(
            "INSERT INTO app_preferences (key, value_json, updated_at) "
            "VALUES (?, ?, ?) "
            "ON CONFLICT(key) DO UPDATE SET "
            "value_json = excluded.value_json, updated_at = excluded.updated_at",
            (
                REVIEW_SETTINGS_KEY,
                dumps_json(
                    {
                        "modelId": normalized.model_id,
                        "enabled": normalized.enabled,
                    }
                ),
                utc_now_iso(),
            ),
        )
    return normalized


def resolve_review_model(model_id: str | None = None):
    """解析复盘模型定义；未知模型返回 None。"""

    return get_custom_model_definition(model_id) or get_model(model_id)
