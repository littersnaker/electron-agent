"""媒体生成接口数据结构。"""

from __future__ import annotations

from typing import Literal

from pydantic import Field

from backend.schemas.common import FlexibleModel, FrontendAttachment


MediaMode = Literal[
    "text-to-image",
    "image-edit",
    "text-to-video",
    "image-to-video",
    "reference-to-video",
    "video-edit",
]


class MediaGenerateBody(FlexibleModel):
    """前端图片或视频生成请求。"""

    model_id: str = Field(alias="modelId")
    session_id: str = Field(default="", alias="sessionId")
    checkpoint_id: str = Field(default="", alias="checkpointId")
    mode: MediaMode
    prompt: str
    typography_policy: str = Field(default="avoid-generated-text", alias="typographyPolicy")
    image_edit_fidelity: str = Field(default="precise", alias="imageEditFidelity")
    enable_quality_guard: bool = Field(default=True, alias="enableQualityGuard")
    attachment: FrontendAttachment | None = None
    attachments: list[FrontendAttachment] = Field(default_factory=list)
    size: str | None = None
    seed: int | None = None
    negative_prompt: str | None = Field(default=None, alias="negativePrompt")
