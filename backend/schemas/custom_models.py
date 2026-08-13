"""用户自定义模型接口的数据结构（聊天 + 媒体）。"""

from __future__ import annotations

from typing import Literal

from pydantic import Field, field_validator

from backend.schemas.common import FlexibleModel

ProviderId = Literal[
    "qwen",
    "openai",
    "gemini",
    "deepseek",
    "glm",
    "kimi",
    "doubao",
]

MediaMode = Literal["text-to-image", "text-to-video", "image-edit"]
MediaProtocol = Literal["", "qwen-image-sync", "volcengine-image", "volcengine-video-async"]
MediaOutputKind = Literal["", "image", "video"]


class CustomModelInput(FlexibleModel):
    """新增或修改自定义模型时使用的请求体。"""

    name: str = Field(min_length=1, max_length=80)
    provider: ProviderId
    model: str = Field(min_length=1, max_length=160)
    base_url: str | None = Field(default=None, alias="baseUrl", max_length=500)
    include_in_auto: bool = Field(default=True, alias="includeInAuto")
    auto_priority: int = Field(default=10, alias="autoPriority", ge=1, le=9999)
    supports_vision: bool = Field(default=False, alias="supportsVision")
    # 媒体能力：空数组表示纯聊天模型；填了 modes 的模型会出现在媒体选择器里。
    media_modes: list[MediaMode] = Field(default_factory=list, alias="mediaModes")
    media_protocol: MediaProtocol = Field(default="", alias="mediaProtocol")
    media_output_kind: MediaOutputKind = Field(default="", alias="mediaOutputKind")

    @field_validator("name", "model")
    @classmethod
    def strip_required_text(cls, value: str) -> str:
        """去除首尾空白，并拒绝只有空格的名称或模型值。"""

        normalized = value.strip()
        if not normalized:
            raise ValueError("字段不能为空")
        return normalized

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str | None) -> str | None:
        """只允许保存 HTTP(S) Base URL，避免协议拼写错误。"""

        normalized = (value or "").strip().rstrip("/")
        if not normalized:
            return None
        if not normalized.startswith(("https://", "http://")):
            raise ValueError("Base URL 必须以 http:// 或 https:// 开头")
        return normalized

    @field_validator("media_modes")
    @classmethod
    def validate_media_modes(cls, value: list[MediaMode]) -> list[MediaMode]:
        """媒体协议/输出类型只在声明了媒体模式时才有意义，否则清空。"""

        if not value:
            return []
        return list(dict.fromkeys(value))


class CustomModelRecord(CustomModelInput):
    """返回给前端的自定义模型记录。"""

    id: str
    created_at: str = Field(alias="createdAt")
    updated_at: str = Field(alias="updatedAt")
