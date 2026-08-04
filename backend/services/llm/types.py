"""LLM 网关内部数据结构。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal


@dataclass(slots=True)
class ImagePart:
    """Provider 无关的 Base64 图片内容。"""

    mime_type: str
    data: str
    name: str = "image"


@dataclass(slots=True)
class LlmMessage:
    """Provider 无关的聊天消息。"""

    role: Literal["system", "user", "assistant"]
    content: str
    images: list[ImagePart] = field(default_factory=list)


@dataclass(slots=True)
class LlmUsage:
    """单次模型调用的 Token 用量。"""

    prompt: int = 0
    completion: int = 0
    total: int = 0


@dataclass(slots=True)
class LlmChunk:
    """流式模型响应中的一个增量片段。"""

    text_delta: str = ""
    reasoning_delta: str = ""
    usage: LlmUsage | None = None
