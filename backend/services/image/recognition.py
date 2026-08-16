"""逐张串行识别货架照片：GLM-4.6V 识别图纸编号在货架上的位置。

每张照片独立调用 GLM-4.6V（共享层已做全局节流，此处不再自建锁）。单张失败
（超时/限流重试耗尽/无法辨认）只记入失败清单并继续下一张，保证已消耗的速率
不白费——成功张的结果全部保留。

GLM-4.6V 是免费模型，输出格式不稳定（可能给编号加方括号、把多条记录挤在一行、
使用全角符号）。解析器因此使用正则从任意文本中提取 ``编号+第N层+第M位`` 三元组，
不依赖换行或分隔符位置，并对编号做方括号/空白清洗。
"""

from __future__ import annotations

import logging
import re

from backend.services.glm46v.client import (
    GLM46VClient,
    GLM46VError,
    ImageInput,
)
from backend.services.image.models import ImageRecognitionFailure, SheetRecognition

LOGGER = logging.getLogger(__name__)

MAX_RECOGNITIONS_PER_IMAGE = 120
# GLM-4.6V 单次请求最多 8 张图（client 常量），裁剪标签按此分批。
TAG_BATCH_SIZE = 8

# 不确定标记：GLM 表达“看不清/不确定”时不能输出编号，避免把猜错的数据写进 Excel。
_TAG_UNCERTAIN_MARKERS = ("无法辨认", "不确定", "模糊", "看不清", "?", "？", "未知")

# 容忍 [编号]、[第N层]、全角｜、多余空白与缺失分隔符，从任意文本中提取三元组。
_RECORD_PATTERN = re.compile(
    r"\[?\s*(\d{1,4})\s*\]?\s*[|｜]\s*\[?\s*第\s*(\d+)\s*层"
    r"\s*[|｜]?\s*\[?\s*第\s*(\d+)\s*位"
)

_TAG_BATCH_PROMPT = """你是货架标签识别员。下面有若干张标签小图，每张图上有且只有一个编号。

要求：
1. 按图片顺序逐张读出编号，每行一个，直接输出数字本身。
2. 只有百分之百确定的编号才输出；有任何不确定、模糊、看不清的，
   一律写“无法辨认”，绝对不要猜测或编造编号。
3. 不要输出任何解释、方括号、引号或 Markdown 标记。
"""


def build_tag_batch_prompt(count: int) -> str:
    """生成按图顺序输出编号的批次提示词。"""

    return f"{_TAG_BATCH_PROMPT}\n共 {count} 张图。请按顺序输出 {count} 行编号。"

_RECOGNITION_PROMPT = """你是货架图纸识别员。请仔细查看这张货架照片，完成以下任务：

1. 货架可能有若干层，每层从左到右有若干货位；每个货位贴着唯一编号的图纸。
2. 请按“从上到下”的层序（最上层为第 1 层）、“从左到右”的位序（最左为第 1 位）
   识别每个货位上的图纸编号。
3. 只输出贴有图纸的货位；空出的货位、看不清的货位不要输出编号。
4. 编号看不清时，在备注写“编号无法辨认”，但仍给出它所在的层与位。
5. 输出格式：每条记录独占一行，编号只写数字，不要加方括号、引号或其他符号。
   行内用竖线分隔，例如：
   003|第1层|第2位|
   005|第2层|第3位|编号无法辨认
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
) -> tuple[list[SheetRecognition], str, str | None]:
    """识别单张照片，返回 ``(识别行, 总结, 失败原因)``。

    ``失败原因`` 非 None 表示调用或解析级失败（由上层降级，不中断其他照片）；
    为 None 但行数为空表示识别成功但未找到图纸编号（同样不算失败）。
    """

    try:
        result = await client.analyze_images([image], prompt=prompt)
    except GLM46VError as exc:
        return [], "", f"视觉识别失败：{exc}"
    except Exception as exc:  # noqa: BLE001 - 单张降级需兼容未知网络/客户端错误。
        LOGGER.exception("GLM 视觉识别出现未预期错误")
        return [], "", f"视觉识别出现未预期错误：{exc}"

    content = str(result.get("content") or "").strip()
    if not content:
        return [], "", "视觉模型没有返回识别结果"
    rows, summary = _parse_glm_output(content, source_image=image.name)
    return rows, summary, None


def _parse_glm_output(content: str, *, source_image: str) -> tuple[list[SheetRecognition], str]:
    """从 GLM 输出中提取全部 ``编号|第N层|第M位`` 记录。

    使用正则 ``finditer`` 一次扫描整段文本（不依赖换行），编号去除方括号等杂质；
    位号之后到下一条记录之间的文本作为备注，清洗掉方括号与分隔符。
    """

    parsed: list[SheetRecognition] = []
    matches = list(_RECORD_PATTERN.finditer(content))
    for index, match in enumerate(matches):
        sheet_no = match.group(1)
        row_number = int(match.group(2))
        col_number = int(match.group(3))
        note = ""
        if index + 1 < len(matches):
            between = content[match.end() : matches[index + 1].start()]
        else:
            between = content[match.end() :]
        cleaned = re.sub(r"[\[\]|｜·\s]", "", between)
        if cleaned and cleaned != sheet_no:
            note = cleaned
        # 不确定的编号不输出（整图路径：GLM 已标注无法辨认/不确定）。
        if any(marker in note for marker in _TAG_UNCERTAIN_MARKERS):
            continue
        parsed.append(
            SheetRecognition(
                sheet_no=sheet_no,
                row=f"第{row_number}层",
                col=f"第{col_number}位",
                source_image=source_image,
                note=note,
            )
        )
        if len(parsed) >= MAX_RECOGNITIONS_PER_IMAGE:
            break

    if not parsed:
        summary = content
    else:
        summary = f"照片 {source_image} 识别到 {len(parsed)} 个图纸编号"
    return parsed, summary


async def recognize_tag_batches(
    *,
    crops: list[ImageInput],
    client: GLM46VClient,
) -> list[str | None]:
    """分批识别裁剪出的标签小图，返回与输入同序的编号列表。

    每批最多 8 张小图（GLM 单次上限）；单批调用失败或某张无法辨认时，
    该标签置为 None（由上层记入失败清单），不中断后续批次。
    """

    results: list[str | None] = []
    for start in range(0, len(crops), TAG_BATCH_SIZE):
        batch = crops[start : start + TAG_BATCH_SIZE]
        try:
            result = await client.analyze_images(
                batch,
                prompt=build_tag_batch_prompt(len(batch)),
            )
        except Exception as exc:  # noqa: BLE001 - 单批失败降级，与整图路径一致。
            LOGGER.warning("标签批次识别失败（%d 张）：%s", len(batch), exc)
            results.extend([None] * len(batch))
            continue

        lines = [
            line.strip().lstrip("-*· ")
            for line in str(result.get("content") or "").splitlines()
            if line.strip()
        ]
        parsed: list[str | None] = []
        for line in lines:
            if any(marker in line for marker in _TAG_UNCERTAIN_MARKERS):
                parsed.append(None)
            else:
                parsed.append(_extract_sheet_no(line))
            if len(parsed) >= len(batch):
                break
        while len(parsed) < len(batch):
            parsed.append(None)
        results.extend(parsed[: len(batch)])
    return results[: len(crops)]


def _extract_sheet_no(line: str) -> str | None:
    """从一行文本中提取第一个数字编号（纯数字）。"""

    match = re.search(r"\d{1,4}", line)
    if not match:
        return None
    return match.group(0)


def classify_failure_kind(reason: str) -> str:
    """按错误文本区分失败性质：429 限流 → rate_limited，其余 → other。"""

    if "429" in reason or "访问量过大" in reason or "限流" in reason:
        return "rate_limited"
    return "other"


def merge_recognitions(
    per_image: list[tuple[str, list[SheetRecognition], str | None]],
) -> tuple[list[SheetRecognition], list[ImageRecognitionFailure], list[str]]:
    """合并逐张识别结果，返回总行、失败清单与逐张总结。"""

    rows: list[SheetRecognition] = []
    failures: list[ImageRecognitionFailure] = []
    summaries: list[str] = []
    for image_name, image_rows, error in per_image:
        if error is not None:
            failures.append(
                ImageRecognitionFailure(
                    image_name=image_name,
                    reason=error,
                    kind=classify_failure_kind(error),
                )
            )
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
    "TAG_BATCH_SIZE",
    "build_recognition_prompt",
    "build_tag_batch_prompt",
    "classify_failure_kind",
    "merge_recognitions",
    "recognize_single_image",
    "recognize_tag_batches",
]
