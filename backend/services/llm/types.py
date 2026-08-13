"""LLM 网关内部数据结构。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal


@dataclass(slots=True)
class ImagePart:
    """Provider 无关的 Base64 图片内容。"""

    mime_type: str
    data: str
    name: str = "image"


@dataclass(slots=True)
class LlmToolCall:
    """模型返回的原生 Function Call。"""

    name: str
    arguments: str
    id: str = ""


@dataclass(slots=True)
class LlmMessage:
    """Provider 无关的聊天消息。"""

    role: Literal["system", "user", "assistant", "tool"]
    content: str
    images: list[ImagePart] = field(default_factory=list)
    # 原生 Function Calling：assistant 消息携带模型返回的工具调用；
    # tool 角色消息携带对某个 tool_call_id 的工具执行结果。
    tool_calls: list[LlmToolCall] = field(default_factory=list)
    tool_call_id: str = ""


@dataclass(slots=True)
class LlmUsage:
    """单次模型调用的 Token 用量。"""

    prompt: int = 0
    completion: int = 0
    total: int = 0
    cached_tokens: int = 0


@dataclass(slots=True)
class LlmChunk:
    """流式模型响应中的一个增量片段。"""

    text_delta: str = ""
    reasoning_delta: str = ""
    usage: LlmUsage | None = None
    tool_calls: list[LlmToolCall] = field(default_factory=list)


@dataclass(slots=True)
class LlmToolDefinition:
    """发给模型的原生工具 Schema（OpenAI 兼容 function）。"""

    name: str
    description: str
    parameters: dict[str, Any]
