"""把识别结果导出为 xlsxwriter 生成的 Excel 货架矩阵。

主工作表按货架网格布局：每个层一个区块，区块内每行是一个叠放排、每列是一个
货位，格子为编号或留空（看不清/不确定的位置留空）。识别失败的图片单独记录在
“识别失败清单”工作表。

使用 xlsxwriter 而非 openpyxl：openpyxl 3.1+ 把字符串全部写成 inlineStr
内联格式，WPS 打开这种文件会出现整表空白；xlsxwriter 使用经典 sharedStrings
共享字符串格式，WPS/Excel 兼容性最好。

所有写入单元格的文本都会先清洗 XML 非法控制字符（GLM 识别文本可能夹杂
\\x00-\\x08 等字符，直接写入会让 xlsx 损坏、WPS/Excel 打不开）。
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from backend.services.image.models import ImageRecognitionFailure, SheetRecognition

EXCEL_FILENAME_PATTERN = r"^[\w.\-\u4e00-\u9fff]{1,160}$"
EXCEL_SHEET_PREFIX = "货架图纸识别_"

# XML 1.0 非法控制字符（xlsx 是 zip+XML，含这些字符文件会损坏）。
# 范围外的 \ufffe/\uffff 也是 XML 非字符，一并剥离。
_XML_ILLEGAL_RE = re.compile(
    "[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]",
)


def clean_cell_text(value: object) -> str:
    """清洗单元格文本：剥离 XML 非法控制字符并规范化空白。"""

    if value is None:
        return ""
    text = str(value)
    cleaned = _XML_ILLEGAL_RE.sub("", text)
    return " ".join(cleaned.split())


def build_excel_filename() -> str:
    """生成 Excel 文件名（含时间戳，路径安全）。"""

    stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    return f"{EXCEL_SHEET_PREFIX}{stamp}.xlsx"


def is_safe_excel_filename(value: str) -> bool:
    """校验下载文件名白名单，防止路径穿越。"""

    return bool(re.match(EXCEL_FILENAME_PATTERN, value))


def write_recognition_excel(
    *,
    directory: Path,
    rows: list[SheetRecognition],
    failures: list[ImageRecognitionFailure],
    summary: str,
) -> Path:
    """生成 Excel 文件并返回其路径。

    主工作表按货架网格布局：每个层一个区块，区块内每一行是一个叠放排，
    每一列是一个货位，格子为编号或留空（看不清/不确定的位置留空）。
    """

    try:
        from xlsxwriter import Workbook
    except ImportError as exc:  # pragma: no cover - 构建环境必带 xlsxwriter
        raise RuntimeError(
            "图片识别导出 Excel 依赖缺失（"
            f"{exc}）。开发环境请执行 pip install -r requirements.txt；"
            "桌面版需要重新构建（pnpm electron:make:win）后才会包含 xlsxwriter。"
        ) from exc

    directory.mkdir(parents=True, exist_ok=True)
    filename = build_excel_filename()
    target = directory / filename
    workbook = Workbook(str(target))

    if rows:
        from backend.services.image.models import build_layers

        header_format = workbook.add_format(
            {
                "bold": True,
                "font_color": "#FFFFFF",
                "bg_color": "#4472C4",
                "align": "center",
            }
        )
        board_format = workbook.add_format(
            {
                "bold": True,
                "font_color": "#FFFFFF",
                "bg_color": "#70AD47",
                "align": "center",
            }
        )
        stack_format = workbook.add_format(
            {
                "bold": True,
                "font_color": "#FFFFFF",
                "bg_color": "#4472C4",
                "align": "center",
            }
        )
        value_format = workbook.add_format({"align": "center"})
        unknown_format = workbook.add_format(
            {
                "font_color": "#999999",
                "italic": True,
                "bg_color": "#F2F2F2",
                "align": "center",
            }
        )
        sheet = workbook.add_worksheet("图纸编号")
        cursor = 0
        for layer_block in build_layers(rows):
            layer = int(layer_block["layer"])
            max_stack = int(layer_block["maxStack"])
            max_position = int(layer_block["maxPosition"])
            cells = layer_block["cells"]  # list[list[dict | None]]  [stack][position]

            # 层标题
            sheet.write_string(cursor, 0, f"第{layer}层", board_format)
            cursor += 1

            # 表头：货位
            sheet.write_string(cursor, 0, "货位", header_format)
            for position in range(1, max_position + 1):
                sheet.write_string(cursor, position, f"第{position}位", header_format)
            cursor += 1

            # 每排一行：格子为编号或留空（看不清/不确定）
            for stack_index in range(max_stack):
                sheet.write_string(cursor, 0, f"排{stack_index + 1}", stack_format)
                row_cells = cells[stack_index] if stack_index < len(cells) else []
                for position in range(1, max_position + 1):
                    cell = (
                        row_cells[position - 1]
                        if position - 1 < len(row_cells)
                        else None
                    )
                    if cell is None:
                        continue
                    sheet_no = clean_cell_text(cell["sheetNo"])
                    if sheet_no:
                        sheet.write_string(cursor, position, sheet_no, value_format)
                    else:
                        # 占位格：位置存在但编号无法辨认，灰色斜体标识。
                        sheet.write_string(cursor, position, "空", unknown_format)
                cursor += 1
            cursor += 1  # 层之间的空行分隔

        sheet.set_column(0, max(1, max_position), 10)
        sheet.freeze_panes(1, 0)
    else:
        # 无识别结果时第一个工作表给明确说明，避免打开只见空表头。
        notice = workbook.add_worksheet("识别结果")
        notice.write_string(0, 0, "未识别到图纸编号。")
        notice.write_string(
            1,
            0,
            "请查看“识别失败清单”与“识别总结”；若为免费模型限流，稍等 1-2 分钟后重试。",
        )
        notice.set_column(0, 0, 70)

    if failures:
        failure_sheet = workbook.add_worksheet("识别失败清单")
        failure_sheet.write_row(0, 0, ["来源照片", "失败类型", "失败原因"])
        for index, item in enumerate(failures, start=1):
            failure_sheet.write_row(
                index,
                0,
                [
                    clean_cell_text(item.image_name),
                    {
                        "rate_limited": "限流（稍后重试）",
                        "other": "其他",
                        "quality": "照片质量",
                    }.get(item.kind, item.kind),
                    clean_cell_text(item.reason),
                ],
            )
        failure_sheet.set_column(0, 0, 28)
        failure_sheet.set_column(1, 1, 20)
        failure_sheet.set_column(2, 2, 48)

    if summary:
        summary_sheet = workbook.add_worksheet("识别总结")
        summary_sheet.write_string(0, 0, clean_cell_text(summary))
        summary_sheet.set_column(0, 0, 80)

    workbook.close()
    return target


__all__ = [
    "build_excel_filename",
    "clean_cell_text",
    "is_safe_excel_filename",
    "write_recognition_excel",
]
