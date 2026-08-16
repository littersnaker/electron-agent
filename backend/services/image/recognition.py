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
import os
import re

from backend.services.glm46v.client import (
    GLM46VClient,
    GLM46VError,
    ImageInput,
)
from backend.services.image.models import (
    UNCERTAIN_MARKERS,
    ImageRecognitionFailure,
    SheetRecognition,
)

LOGGER = logging.getLogger(__name__)

MAX_RECOGNITIONS_PER_IMAGE = 120
# GLM-4.6V 单次请求最多 8 张图（client 常量），裁剪标签按此分批。
TAG_BATCH_SIZE = 8
# 网格解析后的幻觉抑制阈值：某层位宽超过中位数的 2 倍且差 ≥3 时截断到中位数。
# 免费视觉模型偶发“第 N 层有 16 个货位”这类虚构，货架每层货位通常均匀，
# 用中位数兜底把明显超出的虚构位裁掉，避免网格被撑爆。
GRID_WIDTH_HALLUCINATION_FACTOR = 2.0
GRID_WIDTH_MIN_DIFF = 3

# 容忍 [编号]、[第N层]、全角｜、多余空白与缺失分隔符，从任意文本中提取三元组。
# 带叠放排：003|第1层|第2排|第5位|（编号在前，排位可选）
_RECORD_WITH_STACK_PATTERN = re.compile(
    r"\[?\s*(\d{1,4})\s*\]?\s*[|｜]\s*\[?\s*第\s*(\d+)\s*层"
    r"\s*[|｜]\s*\[?\s*第\s*(\d+)\s*排\s*[|｜]\s*\[?\s*第\s*(\d+)\s*位"
)
# 无叠放排：003|第1层|第5位|
_RECORD_BASE_PATTERN = re.compile(
    r"\[?\s*(\d{1,4})\s*\]?\s*[|｜]\s*\[?\s*第\s*(\d+)\s*层"
    r"\s*[|｜]?\s*\[?\s*第\s*(\d+)\s*位"
)
# 只有坐标 + 无法辨认：第1层|第3位|编号无法辨认（编号缺失也要保留占位）
_RECORD_UNCERTAIN_PATTERN = re.compile(
    r"\[?\s*第\s*(\d+)\s*层\s*[|｜]?\s*\[?\s*第\s*(\d+)\s*位"
    r"[^0-9]{0,40}?(编号无法辨认|无法辨认|不确定|模糊|看不清|未知)"
)

# 完整网格模板：第1层：第1位=325, 第2位=空, 第3位=编号无法辨认, ...
# 支持“第1层第2排：”形式的叠放排；位号是绝对物理货位号，空位也显式输出。
_GRID_LINE_PATTERN = re.compile(
    r"第\s*(\d+)\s*层(?:第\s*(\d+)\s*排)?\s*[:：]\s*([^\n]+)"
)
_GRID_CELL_PATTERN = re.compile(
    r"第\s*(\d+)\s*位\s*[=＝:]?\s*([^,，;；、\n]+)"
)

# 紧凑网格模板（glm-4v-flash 的 max_tokens 上限 1024，必须压缩输出）：
# 每层一行 “第N层:1=编号,2=编号;2排:1=编号;3排:1=编号”，叠放排作为分号段。
_COMPACT_LAYER_LINE = re.compile(r"第\s*(\d+)\s*层\s*[:：]\s*([^\n]*)")
_COMPACT_STACK_PREFIX = re.compile(r"^\s*(\d+)\s*排\s*[:：]\s*(.*)$")
_COMPACT_CELL = re.compile(r"(\d+)\s*[=＝]\s*([^,，;；\n]+)")

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

_RECOGNITION_PROMPT = """你是货架图纸识别员。照片里的货架有若干层，每层从左到右有若干货位；
**每个货位可能上下叠放多张图纸（2-3 层），叠放的每一张都要单独识别**。

坐标规则：
1. 第1层 = 照片中最上面的一层，依次往下编号。
2. 货位从左到右编号，第1位 = 最左边；位号是物理货位号，不能跳过空位。
3. 同一货位叠放多张图纸时，从上到下依次为第1排、第2排、第3排。

输出格式（严格按模板，不要解释或 Markdown）：
第1层：第1位=325, 第2位=空, 第3位=43, ...
第1层第2排：第1位=088, ...
第1层第3排：第1位=122, ...

规则：
- 先逐货位数清楚叠放了几张图纸：只有1张就只写“第N层：”；有2张就写“第N层：”和“第N层第2排：”；
  有3张就写“第N层：”“第N层第2排：”“第N层第3排：”，每张一行；
- 每一排都从第1位开始连续列出该排所有货位，一个都不能漏，空位写“空”；
- 有图纸但编号看不清的写“编号无法辨认”；
- 编号只写数字本身，不要方括号、引号；
- 不要虚构不存在的层、排或货位，数不清就写“数不清”；
- 如果照片里没有货架或图纸，只输出“未检测到货架图纸”。
"""


def build_recognition_prompt(image_names: str) -> str:
    """生成带图片清单的固定识别提示词。"""

    return (
        f"{_RECOGNITION_PROMPT}\n\n"
        f"当前照片：{image_names}\n"
        "如照片中没有货架或图纸，请只输出“未检测到货架图纸”。"
    )


_COMPACT_RECOGNITION_PROMPT = """你是货架图纸识别员。照片里的货架有若干层，每层从左到右有若干货位；**每个货位可能上下叠放多张图纸（2-3 层），叠放的每一张都要单独识别**。

坐标规则：第1层=照片中最上面的一层；货位从左到右编号，第1位=最左；同一货位叠放时从上到下为第1排、第2排、第3排。

输出格式（严格按模板，紧凑，不要任何解释或 Markdown）：
第1层:1=325,2=空,3=编号无法辨认;2排:1=179,2=编号无法辨认
第2层:1=62,2=201;2排:1=71,2=240

规则：
- 每层一行，以“第N层:”开头；第1排直接跟在冒号后，第2排用“;2排:”开头，第3排用“;3排:”开头；
- 每排内“位号=编号”逗号分隔，位号从1开始连续；
- **宁可多写“空”或“编号无法辨认”，也绝不能漏掉任何一个货位**：看不清的写“编号无法辨认”，看不到编号但确定有货的写“编号无法辨认”，空货位写“空”；
- 有叠放才写“2排:”“3排:”，没有就不写；
- 编号只写数字；
- 输出必须覆盖照片里的全部层，从上到下逐层输出。
"""


def build_compact_recognition_prompt(image_names: str) -> str:
    """生成 glm-4v-flash 可用的紧凑网格识别提示词（1024 token 输出预算内）。"""

    return (
        f"{_COMPACT_RECOGNITION_PROMPT}\n\n"
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
        result = await client.analyze_images(
            [image], prompt=prompt, include_thinking=False
        )
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
    """从 GLM 输出中提取货位记录，并保留空位与看不清的占位位置。

    优先解析“完整网格模板”（每层每排从第1位连续列出，空位写“空”，
    看不清写“编号无法辨认”），网格解析不到任何行时回退旧的
    ``编号|第N层|第M位`` 管道格式（向后兼容历史模型输出）。
    空位与无法辨认都保留为占位行（sheet_no 为空），前端/Excel 渲染为"空"，
    让用户知道该位置存在但没有编号，而不是凭空消失。
    """

    grid_rows = _parse_grid_output(content, source_image=source_image)
    if grid_rows:
        grid_rows = _trim_hallucinated_widths(grid_rows)
        return _summarize_rows(grid_rows, source_image, content)

    candidates: list[tuple[int, int, re.Match[str]]] = []
    for pattern in (
        _RECORD_WITH_STACK_PATTERN,
        _RECORD_BASE_PATTERN,
        _RECORD_UNCERTAIN_PATTERN,
    ):
        for match in pattern.finditer(content):
            candidates.append((match.start(), match.end(), match))
    candidates.sort(key=lambda item: item[0])

    # 三种模式可能命中同一段文本（如 base 与 uncertain 重叠），按跨度去重。
    accepted: list[tuple[int, int, re.Match[str]]] = []
    previous_end = -1
    for start, end, match in candidates:
        if start < previous_end:
            continue
        previous_end = end
        accepted.append((start, end, match))

    parsed: list[SheetRecognition] = []
    for index, (start, end, match) in enumerate(accepted):
        if match.re is _RECORD_UNCERTAIN_PATTERN:
            # 编号缺失：GLM 只给了坐标 + 无法辨认，保留占位。
            layer = int(match.group(1))
            position = int(match.group(2))
            stack = 1
            sheet_no = ""
            note = "编号无法辨认"
        else:
            sheet_no = match.group(1)
            layer = int(match.group(2))
            if match.re is _RECORD_WITH_STACK_PATTERN:
                stack = int(match.group(3))
                position = int(match.group(4))
            else:
                stack = 1
                position = int(match.group(3))
            if index + 1 < len(accepted):
                between = content[end : accepted[index + 1][0]]
            else:
                between = content[end:]
            cleaned = re.sub(r"[\[\]|｜·\s]", "", between)
            if cleaned and cleaned != sheet_no:
                note = cleaned
            else:
                note = ""
            if any(marker in note for marker in UNCERTAIN_MARKERS):
                # 不确定：坐标保留为占位，编号置空，避免把猜错的数据写进 Excel。
                sheet_no = ""
                note = "编号无法辨认"
        parsed.append(
            SheetRecognition(
                sheet_no=sheet_no,
                layer=layer,
                position=position,
                stack=stack,
                source_image=source_image,
                note=note,
            )
        )
        if len(parsed) >= MAX_RECOGNITIONS_PER_IMAGE:
            break

    return _summarize_rows(parsed, source_image, content)


def _parse_grid_output(
    content: str, *, source_image: str
) -> list[SheetRecognition]:
    """解析“第N层：第1位=..., 第2位=空, ...”完整网格模板。

    支持叠放排行（第N层第M排：...）；空位（空）与无法辨认都生成占位行，
    位号保持 GLM 给出的绝对物理货位号，空位不会被压缩掉。
    """

    parsed: list[SheetRecognition] = []
    seen: set[tuple[int, int, int]] = set()
    for match in _GRID_LINE_PATTERN.finditer(content):
        layer = int(match.group(1))
        stack = int(match.group(2)) if match.group(2) else 1
        payload = match.group(3)
        for cell in _GRID_CELL_PATTERN.finditer(payload):
            position = int(cell.group(1))
            raw_value = cell.group(2).strip()
            key = (layer, stack, position)
            if key in seen:
                continue
            seen.add(key)
            if any(marker in raw_value for marker in UNCERTAIN_MARKERS):
                note = "编号无法辨认"
            elif raw_value == "空" or "无" in raw_value[:3]:
                note = "空货位"
            else:
                number = _extract_sheet_no(raw_value)
                if not number:
                    note = "编号无法辨认"
                else:
                    parsed.append(
                        SheetRecognition(
                            sheet_no=number,
                            layer=layer,
                            position=position,
                            stack=stack,
                            source_image=source_image,
                            note="",
                        )
                    )
                    continue
            parsed.append(
                SheetRecognition(
                    sheet_no="",
                    layer=layer,
                    position=position,
                    stack=stack,
                    source_image=source_image,
                    note=note,
                )
            )
            if len(parsed) >= MAX_RECOGNITIONS_PER_IMAGE:
                return parsed
    return parsed


def _trim_hallucinated_widths(rows: list[SheetRecognition]) -> list[SheetRecognition]:
    """把明显虚构的超宽层截断到中位数宽度，抑制免费模型的位宽幻觉。"""

    widths: dict[int, int] = {}
    for item in rows:
        widths[item.layer] = max(widths.get(item.layer, 0), item.position)
    if len(widths) < 2:
        return rows
    sorted_widths = sorted(widths.values())
    median = sorted_widths[len(sorted_widths) // 2]
    if median < 2:
        return rows
    cap = int(median * GRID_WIDTH_HALLUCINATION_FACTOR)
    trimmed: list[SheetRecognition] = []
    for item in rows:
        if (
            widths[item.layer] > cap
            and widths[item.layer] - median >= GRID_WIDTH_MIN_DIFF
            and item.position > median
        ):
            continue
        trimmed.append(item)
    return trimmed


def _summarize_rows(
    rows: list[SheetRecognition], source_image: str, content: str
) -> tuple[list[SheetRecognition], str]:
    """生成统一的识别总结（含无法辨认与空货位计数）。"""

    recognized = [item for item in rows if item.sheet_no]
    if not rows:
        return [], content
    uncertain = sum(1 for item in rows if not item.sheet_no and item.note == "编号无法辨认")
    empty_slots = sum(1 for item in rows if not item.sheet_no and item.note == "空货位")
    summary = f"照片 {source_image} 识别到 {len(recognized)} 个图纸编号"
    parts: list[str] = []
    if uncertain:
        parts.append(f"{uncertain} 处无法辨认")
    if empty_slots:
        parts.append(f"{empty_slots} 个空货位")
    if parts:
        summary += "，" + "、".join(parts)
    return rows, summary


def _parse_compact_output(
    content: str, *, source_image: str
) -> list[SheetRecognition]:
    """解析 glm-4v-flash 的紧凑网格输出（第N层:1=编号,...;2排:...）。

    每层一行，第 1 排跟在“第N层:”后，叠放排用“;N排:”分号段表示；
    GLM 偶发把“;N排:”段拆到下一行，这里按“第N层:”行切块、其余行并入
    当前层，保证叠放排不丢。空位/无法辨认仍保留为占位行。
    """

    blocks: dict[int, str] = {}
    order: list[int] = []
    current: int | None = None
    for raw_line in content.splitlines():
        line = raw_line.strip()
        match = _COMPACT_LAYER_LINE.search(line)
        if match:
            current = int(match.group(1))
            if current not in blocks:
                blocks[current] = ""
                order.append(current)
            blocks[current] += ";" + match.group(2)
        elif current is not None and line:
            # 续行（如单独一行的 “2排:...”），并入当前层
            blocks[current] += ";" + line

    parsed: list[SheetRecognition] = []
    seen: set[tuple[int, int, int]] = set()
    for layer in order:
        for segment in blocks[layer].split(";"):
            segment = segment.strip()
            if not segment:
                continue
            stack_match = _COMPACT_STACK_PREFIX.match(segment)
            if stack_match:
                stack = int(stack_match.group(1))
                cell_payload = stack_match.group(2)
            else:
                stack = 1
                cell_payload = segment
            for cell in _COMPACT_CELL.finditer(cell_payload):
                position = int(cell.group(1))
                raw_value = cell.group(2).strip()
                key = (layer, stack, position)
                if key in seen:
                    continue
                seen.add(key)
                if any(marker in raw_value for marker in UNCERTAIN_MARKERS):
                    note = "编号无法辨认"
                elif raw_value == "空" or raw_value.startswith("无"):
                    note = "空货位"
                else:
                    number = _extract_sheet_no(raw_value)
                    if not number:
                        note = "编号无法辨认"
                    else:
                        parsed.append(
                            SheetRecognition(
                                sheet_no=number,
                                layer=layer,
                                position=position,
                                stack=stack,
                                source_image=source_image,
                                note="",
                            )
                        )
                        continue
                parsed.append(
                    SheetRecognition(
                        sheet_no="",
                        layer=layer,
                        position=position,
                        stack=stack,
                        source_image=source_image,
                        note=note,
                    )
                )
                if len(parsed) >= MAX_RECOGNITIONS_PER_IMAGE:
                    return parsed
    return parsed


def _split_into_bands(
    image: ImageInput, *, top_ratio: float | None = None
) -> list[ImageInput]:
    """把整图横向切成上下两段（10% 重叠），供 glm-4v-flash 分段识别。

    glm-4v-flash 的输出上限只有 1024 token，一口气输出 6 层会在第 3~4 层
    自行停止；切成两段后每段 2~4 层，输出预算充足。重叠段用于避免
    正好落在切分线上的标签被裁断，层号在合并时统一偏移。
    切分位置可用环境变量 ``IMAGE_SPLIT_RATIO`` 调整（0~1，默认 0.55，
    表示上段占图高 55%）；货架层高分布不均时调它避免切穿某一层。
    """

    import base64 as b64
    import io

    from PIL import Image as PILImage

    if top_ratio is None:
        top_ratio = float(os.getenv("IMAGE_SPLIT_RATIO", "0.55"))
    top_ratio = min(0.9, max(0.1, top_ratio))
    raw = b64.b64decode(image.data)
    img = PILImage.open(io.BytesIO(raw)).convert("RGB")
    width, height = img.size
    if height < 40:
        return [image]
    top = img.crop((0, 0, width, int(height * top_ratio)))
    bottom = img.crop((0, int(height * (top_ratio - 0.10)), width, height))
    bands: list[ImageInput] = []
    for index, band in enumerate((top, bottom), start=1):
        buffer = io.BytesIO()
        band.save(buffer, format="JPEG", quality=90)
        jpeg = buffer.getvalue()
        bands.append(
            ImageInput(
                name=f"{image.name}#{index}",
                mime_type="image/jpeg",
                data=b64.b64encode(jpeg).decode("ascii"),
                size_bytes=len(jpeg),
            )
        )
    return bands


async def recognize_image_segments(
    *,
    image: ImageInput,
    client: GLM46VClient,
    source_name: str,
) -> tuple[list[SheetRecognition], str, str | None]:
    """整图路径 v2：横切两段用 glm-4v-flash 紧凑格式识别，再合并层号。

    两段独立调用（共享全局限流，间隔 ≥2.5s），第一段层号保持 1..k，
    第二段层号偏移 k，合并为完整货架；单段失败只记总结、不中断另一段。
    """

    try:
        bands = _split_into_bands(image)
    except Exception as exc:  # noqa: BLE001 - 分片失败降级为可读错误。
        return [], "", f"图片分片失败：{exc}"

    all_rows: list[SheetRecognition] = []
    summaries: list[str] = []
    layer_offset = 0
    for index, band in enumerate(bands, start=1):
        try:
            result = await client.analyze_images(
                [band],
                prompt=build_compact_recognition_prompt(source_name),
                max_tokens=1024,
                include_thinking=False,
            )
        except Exception as exc:  # noqa: BLE001 - 单段失败降级，另一段继续。
            summaries.append(f"{source_name} 第{index}段识别失败：{exc}")
            continue
        content = str(result.get("content") or "").strip()
        if not content or "未检测到货架图纸" in content or "数不清" in content:
            summaries.append(f"{source_name} 第{index}段未识别到货架图纸")
            continue
        rows = _parse_compact_output(
            content, source_image=f"{source_name}#{index}"
        )
        if not rows:
            summaries.append(f"{source_name} 第{index}段未解析到编号")
            continue
        if index > 1:
            rows = [
                SheetRecognition(
                    sheet_no=item.sheet_no,
                    layer=item.layer + layer_offset,
                    position=item.position,
                    stack=item.stack,
                    source_image=item.source_image,
                    note=item.note,
                )
                for item in rows
            ]
        all_rows.extend(rows)
        layer_offset = max(item.layer for item in all_rows)
        recognized = sum(1 for item in rows if item.sheet_no)
        summaries.append(f"{source_name} 第{index}段识别 {recognized} 个编号")

    if not all_rows:
        return [], "；".join(summaries) or "未识别到任何图纸编号。", None
    return all_rows, "；".join(summaries), None


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
                include_thinking=False,
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
            if any(marker in line for marker in UNCERTAIN_MARKERS):
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
        recognized = [item for item in image_rows if item.sheet_no]
        if image_rows:
            text = f"{image_name}：识别到 {len(recognized)} 个图纸编号"
            unknown = len(image_rows) - len(recognized)
            if unknown:
                text += f"，{unknown} 处无法辨认"
            summaries.append(text)
        else:
            summaries.append(f"{image_name}：未识别到图纸编号")
    return rows, failures, summaries


__all__ = [
    "TAG_BATCH_SIZE",
    "build_compact_recognition_prompt",
    "build_recognition_prompt",
    "build_tag_batch_prompt",
    "classify_failure_kind",
    "merge_recognitions",
    "recognize_image_segments",
    "recognize_single_image",
    "recognize_tag_batches",
]
