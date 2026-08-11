"""LLM Token 用量的统一校正与本地估算。

部分 OpenAI 兼容供应商在流式响应中不会返回 ``usage``。本模块在供应商提供
真实用量时保持原值；缺失时使用稳定的本地估算，确保预算守卫和前端指标不会
长期显示为零。
"""

from __future__ import annotations

import math

from backend.services.llm.types import LlmMessage, LlmUsage

_IMAGE_TOKEN_ESTIMATE = 256
_MESSAGE_OVERHEAD_TOKENS = 4


def estimate_text_tokens(text: str) -> int:
    """根据 UTF-8 字节数保守估算文本 Token 数。

    英文模型通常约四个 ASCII 字符对应一个 Token，中文字符在 UTF-8 中占三个
    字节，因此按四字节一个 Token 估算能兼顾中英文。空文本返回零，避免无意义
    地增加统计。
    """

    if not text:
        return 0
    return max(1, math.ceil(len(text.encode("utf-8")) / 4))


def estimate_prompt_tokens(messages: list[LlmMessage]) -> int:
    """估算一组聊天消息的输入 Token，并计入消息结构和图片基础开销。"""

    total = 0
    for message in messages:
        total += _MESSAGE_OVERHEAD_TOKENS
        total += estimate_text_tokens(message.content)
        total += len(message.images) * _IMAGE_TOKEN_ESTIMATE
    return max(1, total) if messages else 0


def ensure_usage(
    usage: LlmUsage,
    *,
    messages: list[LlmMessage],
    output_text: str,
) -> LlmUsage:
    """返回可用于预算和 UI 的完整 Token 用量。

    供应商返回非零 ``total`` 时优先采用真实统计；仅在字段缺失时补齐组成部分。
    当供应商完全不返回 ``usage`` 时，使用输入消息和最终输出进行本地估算。
    """

    estimated_prompt = estimate_prompt_tokens(messages)
    estimated_completion = estimate_text_tokens(output_text)

    if usage.total > 0:
        prompt = usage.prompt
        completion = usage.completion
        if prompt <= 0 and completion <= 0:
            prompt = min(estimated_prompt, usage.total)
            completion = max(0, usage.total - prompt)
        elif prompt <= 0:
            prompt = max(0, usage.total - completion)
        elif completion <= 0:
            completion = max(0, usage.total - prompt)
        return LlmUsage(prompt=prompt, completion=completion, total=usage.total)

    prompt = max(1, estimated_prompt)
    completion = max(1, estimated_completion)
    return LlmUsage(
        prompt=prompt,
        completion=completion,
        total=prompt + completion,
    )


__all__ = ["ensure_usage", "estimate_prompt_tokens", "estimate_text_tokens"]
