"""逐张串行识别货架照片：GLM-4.6V 识别图纸编号在货架上的位置。

每张照片独立调用 GLM-4.6V（共享层已做全局节流，此处不再自建锁）。单张失败
（超时/限流重试耗尽/无法辨认）只记入失败清单并继续下一张，保证已消耗的速率
不白费——成功张的结果全部保留。
"""

from __future__ import annotations

import logging

from backend.services.glm46v.client import (
    GLM46VClient,
    GLM46VError,
    ImageInput,
)
from backend.services.image.models import ImageRecognitionFailure, SheetRecognition

LOGGER = logging.getLogger(__name__)

MAX_RECOGNITIONS_PER_IMAGE = 120

_RECOGNITION_PROMPT = """你是货架图纸识别员。请仔细查看这张货架照片，完成以下任务：

1. 货架可能有若干层，每层从左到右有若干货位；每个货位贴着唯一编号的图纸。
2. 请按“从上到下”的层序（最上层为第 1 层）、“从左到右”的位序（最左为第 1 位）
   识别每个货位上的图纸编号。
3. 只输出贴有图纸的货位；空出的货位、看不清的货位不要输出编号。
4. 编号看不清时，在备注写“编号无法辨认”，但仍给出它所在的层与位。
5. 输出格式，每行一条，严格如下：
   [编号]|[层]|[位]|[备注]
   例：003|第1层|第2位|
   例：005|第2层|第3位|编号无法辨认
6. 不要输出任何解释、前言或 Markdown 标记。
"""


def build_recognition_prompt(image_names: str) -> str:
    """生成带图片清单的固定识别提示词。"""

    return (
        f"{_RECOGNITION_PROMPT}\n\n"
        f"当前照片：{image_names}\n"
        "如照片中没有货架或图纸，请只输出“未检测到货架图纸”。"
    )


async def recognize_single_image(
    *,
    image: ImageInput,
    client: GLM46VClient,
    prompt: str,
) -> tuple[list[SheetRecognition], str | None]:
    """识别单张照片，返回识别行与可读总结；失败返回 (空列表, 错误文本)。"""

    try:
        result = await client.analyze_images([image], prompt=prompt)
    except GLM46VError as exc:
        return [], f"视觉识别失败：{exc}"
    except Exception as exc:  # noqa: BLE001 - 单张降级需兼容未知网络/客户端错误。
        LOGGER.exception("GLM 视觉识别出现未预期错误")
        return [], f"视觉识别出现未预期错误：{exc}"

    content = str(result.get("content") or "").strip()
    if not content:
        return [], "视觉模型没有返回识别结果"
    rows, summary = _parse_glm_output(content, source_image=image.name)
    return rows, summary


def _parse_glm_output(content: str, *, source_image: str) -> tuple[list[SheetRecognition], str]:
    """把 GLM 的输出解析成结构化的识别行与总结文本。

    优先按 ``[编号]|[层]|[位]|[备注]`` 解析；无法按行解析时把全文作为总结，
    不产出任何识别行，由上层标注为需要人工复核。
    """

    lines = [line.strip() for line in content.splitlines() if line.strip()]
    parsed: list[SheetRecognition] = []
    free_text: list[str] = []
    for line in lines:
        cleaned = line.lstrip("-*· ").strip()
        if not cleaned:
            continue
        parts = [part.strip() for part in cleaned.split("|")]
        if len(parts) >= 3 and parts[0]:
            sheet_no = parts[0]
            if not sheet_no.replace(".", "", 1).isdigit() and not sheet_no.isalnum():
                free_text.append(cleaned)
                continue
            parsed.append(
                SheetRecognition(
                    sheet_no=sheet_no,
                    row=parts[1] or "未知层",
                    col=parts[2] or "未知位",
                    source_image=source_image,
                    note=parts[3] if len(parts) > 3 else "",
                )
            )
            if len(parsed) >= MAX_RECOGNITIONS_PER_IMAGE:
                break
        else:
            free_text.append(cleaned)

    if not parsed:
        summary = content
    else:
        summary = f"照片 {source_image} 识别到 {len(parsed)} 个图纸编号"
    if free_text:
        summary = f"{summary}\n" + "\n".join(free_text[:10])
    return parsed, summary


def merge_recognitions(
    per_image: list[tuple[str, list[SheetRecognition], str | None]],
) -> tuple[list[SheetRecognition], list[ImageRecognitionFailure], list[str]]:
    """合并逐张识别结果，返回总行、失败清单与逐张总结。"""

    rows: list[SheetRecognition] = []
    failures: list[ImageRecognitionFailure] = []
    summaries: list[str] = []
    for image_name, image_rows, error in per_image:
        if error is not None:
            failures.append(ImageRecognitionFailure(image_name=image_name, reason=error))
            continue
        rows.extend(image_rows)
        if image_rows:
            summaries.append(
                f"{image_name}：识别到 {len(image_rows)} 个图纸编号"
            )
        else:
            summaries.append(f"{image_name}：未识别到图纸编号")
    return rows, failures, summaries


__all__ = [
    "build_recognition_prompt",
    "merge_recognitions",
    "recognize_single_image",
]
