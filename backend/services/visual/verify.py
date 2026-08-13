"""视觉验证：截图 → GLM-4.6V 视觉模型分析。

复用 GLM-4.6V 视觉子代理的底层入口（GLM46VClient.analyze_images），
输入是内存中的 Base64 截图，不落盘。任何失败都返回结构化错误而不是抛异常，
保证视觉验证只是 review 的增强环节，不阻断主流程。
"""

from __future__ import annotations

import logging
from typing import Any

from backend.services.glm46v.client import (
    GLM46VClient,
    GLM46VError,
    GLM46VSettings,
    ImageInput,
    normalize_image_data,
)

LOGGER = logging.getLogger(__name__)

VERIFY_SYSTEM_PROMPT = (
    "你是前端验收视觉检查员。请根据任务目标与验收标准，逐项核对这张网页截图。\n"
    "输出格式（纯文本，不要 Markdown 围栏）：\n"
    "1. 结论：通过 / 部分通过 / 未通过\n"
    "2. 逐项核对：每项写 达成/未达成/无法判断 + 一句话证据\n"
    "3. 关键差异：截图里与验收标准不符的具体内容（文字、布局、状态）\n"
    "4. 建议：若未通过，指出最可能的原因\n"
)


def build_verify_prompt(task_summary: str, acceptance: list[str]) -> str:
    """根据任务摘要与验收标准生成视觉核对 prompt。"""

    lines = [VERIFY_SYSTEM_PROMPT, "", f"任务目标：{task_summary or '（未提供）'}"]
    if acceptance:
        lines.append("验收标准：")
        lines.extend(f"- {item}" for item in acceptance[:8])
    return "\n".join(lines)


async def analyze_screenshot(
    *,
    image_base64: str,
    mime_type: str,
    prompt: str,
    credentials: object | None = None,
) -> dict[str, Any]:
    """分析一张内存截图；任何失败返回结构化错误（不抛异常）。"""

    try:
        settings = GLM46VSettings.from_credentials(credentials)
        client = GLM46VClient(settings)
        image: ImageInput = normalize_image_data(
            name="screenshot.png",
            mime_type=mime_type or "image/png",
            data=image_base64,
            max_image_mb=settings.max_image_mb,
        )
        result = await client.analyze_images([image], prompt=prompt)
        return {
            "ok": True,
            "model": result.get("model") or "",
            "content": result.get("content") or "",
            "usage": result.get("usage") or {},
        }
    except GLM46VError as exc:
        LOGGER.warning("视觉验证 GLM 调用失败：%s", exc)
        return {"ok": False, "error": str(exc)}
    except Exception as exc:  # noqa: BLE001 - 视觉验证是增强环节，绝不阻断 review。
        LOGGER.exception("视觉验证意外失败")
        return {"ok": False, "error": str(exc)[:300]}


__all__ = ["analyze_screenshot", "build_verify_prompt"]
