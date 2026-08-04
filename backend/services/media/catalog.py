"""媒体模型注册表：运行时读取 ``config/media-models.json``。"""

from __future__ import annotations

import json
from pathlib import Path

CONFIG_PATH = Path(__file__).resolve().parents[3] / "config" / "media-models.json"


def _load_media_models() -> list[dict[str, object]]:
    """读取媒体模型配置；缺失或损坏时快速失败。"""

    try:
        payload = json.loads(CONFIG_PATH.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise RuntimeError(
            f"媒体模型配置文件缺失或损坏：{CONFIG_PATH}（{exc}）"
        ) from exc
    return [
        item
        for item in (payload.get("models") or [])
        if isinstance(item, dict)
    ]


MEDIA_MODELS: list[dict[str, object]] = _load_media_models()


def get_media_model(model_id: str) -> dict[str, object]:
    """按前端媒体模型 ID 返回注册信息。"""

    for model in MEDIA_MODELS:
        if model["id"] == model_id:
            return model
    raise ValueError(f"未注册的媒体模型：{model_id}")


__all__ = [
    "MEDIA_MODELS",
    "get_media_model",
]
