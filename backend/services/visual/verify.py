"""视觉 Review：滚动截图分帧 → LLM 网关视觉模型分析。

截图分帧以 Base64 在内存中传递，不落盘。视觉模型由用户在设置里配置的
自定义模型决定（如 DeepSeek deepseek-v4-flash-vision-exp，勾选 supportsVision），
请求经 LLM GATEWAY 走标准 OpenAI 多模态 content 协议；不指定模型时由网关
在带图请求下自动挑选支持 Vision 的候选。任何失败都返回结构化错误而不是
抛异常，保证视觉 Review 只是增强环节，不阻断主流程。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from backend.services.llm.catalog import AUTO_MODEL_ID
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import ImagePart, LlmMessage

LOGGER = logging.getLogger(__name__)

# 单次 Review 最多送入视觉模型的帧数；DeepSeek 视觉模型按多图请求计费，
# 6 帧（约 6 屏）已覆盖绝大多数落地页与工作台页面。
MAX_REVIEW_FRAMES = 6

REVIEW_PROMPT_TEMPLATE = (
    "你是前端视觉验收检查员。下面是同一个网页从上到下自动滚动截出的 {frame_count} 张"
    "分段截图（按顺序拼接即为完整页面）。\n"
    "请整体审查页面的视觉质量，输出格式（纯文本，不要 Markdown 围栏）：\n"
    "1. 结论：通过 / 部分通过 / 未通过\n"
    "2. 问题清单：逐条列出发现的具体问题（布局错乱、内容溢出、元素重叠、对比度不足、"
    "破图/裂图、占位文案、明显未渲染区块等），标注出现在第几张截图\n"
    "3. 亮点：值得保留的视觉优点（可选，最多两条）\n"
    "4. 建议：若未通过，指出最可能的原因和修复方向\n"
    "\n任务目标：{task_summary}"
)


@dataclass(slots=True)
class ReviewFrame:
    """一帧滚动截图：PNG/JPEG Base64（不含 data: 前缀）。"""

    data: str
    mime_type: str = "image/png"


def build_review_prompt(task_summary: str, frame_count: int) -> str:
    """根据任务摘要与帧数生成视觉 review prompt。"""

    return REVIEW_PROMPT_TEMPLATE.format(
        frame_count=frame_count,
        task_summary=task_summary.strip() or "（未提供，按通用页面质量标准审查）",
    )


async def review_screenshots(
    *,
    frames: list[ReviewFrame],
    task_summary: str,
    credentials: LlmCredentials,
    model_id: str = "",
) -> dict[str, Any]:
    """把多帧截图交给网关视觉模型审查；任何失败返回结构化错误（不抛异常）。"""

    usable = [frame for frame in frames if str(frame.data).strip()][:MAX_REVIEW_FRAMES]
    if not usable:
        return {"ok": False, "error": "没有可分析的截图帧"}

    prompt = build_review_prompt(task_summary, len(usable))
    message = LlmMessage(
        role="user",
        content=prompt,
        images=[
            ImagePart(
                mime_type=frame.mime_type or "image/png",
                data=frame.data,
                name=f"frame-{index + 1}.png",
            )
            for index, frame in enumerate(usable)
        ],
    )
    try:
        content, usage, model = await GATEWAY.complete(
            preferred_model_id=(model_id or "").strip() or AUTO_MODEL_ID,
            credentials=credentials,
            messages=[message],
            temperature=0.2,
            timeout_seconds=300,
        )
        return {
            "ok": True,
            "model": model.model,
            "content": content,
            "frameCount": len(usable),
            "usage": {"prompt": usage.prompt, "completion": usage.completion, "total": usage.total},
        }
    except Exception as exc:  # noqa: BLE001 - 视觉 Review 是增强环节，绝不阻断主流程。
        LOGGER.warning("视觉 Review 模型调用失败：%s", exc)
        error = str(exc)[:300]
        if "图像输入" in error or "Vision" in error or "vision" in error:
            error += (
                "（请在设置 → 自定义模型中添加勾选「支持视觉」的模型，"
                "例如 provider=deepseek、model=deepseek-v4-flash-vision-exp）"
            )
        return {"ok": False, "error": error}


__all__ = ["MAX_REVIEW_FRAMES", "ReviewFrame", "build_review_prompt", "review_screenshots"]
