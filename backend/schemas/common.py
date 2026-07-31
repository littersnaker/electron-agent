"""跨接口共享的数据结构。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class FlexibleModel(BaseModel):
    """允许前端携带未来新增字段的基础模型。"""

    model_config = ConfigDict(extra="allow", populate_by_name=True)


class MessageAttachment(FlexibleModel):
    """聊天消息中用于展示和下载的附件。"""

    name: str
    type: str
    data_url: str | None = Field(default=None, alias="dataUrl")
    url: str | None = None
    asset_kind: Literal["image", "video", "file"] | None = Field(
        default=None, alias="assetKind"
    )
    download_name: str | None = Field(default=None, alias="downloadName")


class StoredMessage(FlexibleModel):
    """持久化到 SQLite 的聊天消息。"""

    role: Literal["user", "assistant"]
    content: str
    attachments: list[MessageAttachment] | None = None
    commerce_report: dict[str, Any] | None = Field(default=None, alias="commerceReport")
    commerce_listing: dict[str, Any] | None = Field(default=None, alias="commerceListing")


class FrontendMessage(FlexibleModel):
    """前端发送给文本模型的简化消息。"""

    role: Literal["user", "assistant", "system"]
    content: str


class FrontendAttachment(FlexibleModel):
    """前端发送给模型的图片或媒体附件。"""

    name: str = "attachment"
    mime_type: str = Field(default="application/octet-stream", alias="mimeType")
    data: str | None = None
    data_url: str | None = Field(default=None, alias="dataUrl")


class TokenUsage(FlexibleModel):
    """统一的文本 Token 或媒体额度统计。"""

    prompt: int = 0
    completion: int = 0
    total: int = 0
    unit: Literal["tokens", "images", "videos", "requests"] = "tokens"
    label: str | None = None
    auxiliary_prompt: int | None = Field(default=None, alias="auxiliaryPrompt")
    auxiliary_completion: int | None = Field(default=None, alias="auxiliaryCompletion")
    auxiliary_total: int | None = Field(default=None, alias="auxiliaryTotal")
    auxiliary_label: str | None = Field(default=None, alias="auxiliaryLabel")
