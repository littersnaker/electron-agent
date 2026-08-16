"""把识别结果导出为 openpyxl 生成的 Excel 长表。

表格字段：图纸编号 | 所在层 | 所在位 | 来源照片 | 备注。识别失败的图片单独
记录在“识别失败清单”工作表，方便用户补拍后重跑。
"""

from __future__ import annotations

import re
from datetime import datetime
from pathlib import Path

from backend.services.image.models import ImageRecognitionFailure, SheetRecognition

EXCEL_FILENAME_PATTERN = r"^[\w.\-\u4e00-\u9fff]{1,160}$"
EXCEL_SHEET_PREFIX = "货架图纸识别_"


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
    """生成 Excel 文件并返回其路径。"""

    try:
        from openpyxl import Workbook
        from openpyxl.styles import Alignment, Font, PatternFill
        from openpyxl.utils import get_column_letter
    except ImportError as exc:  # pragma: no cover - 构建环境必带 openpyxl
        raise RuntimeError(
            "图片识别导出 Excel 依赖缺失（"
            f"{exc}）。开发环境请执行 pip install -r requirements.txt；"
            "桌面版需要重新构建（pnpm electron:make:win）后才会包含 openpyxl。"
        ) from exc

    directory.mkdir(parents=True, exist_ok=True)
    filename = build_excel_filename()
    target = directory / filename
    workbook = Workbook()

    sheet = workbook.active
    sheet.title = "图纸编号"
    headers = ["图纸编号", "所在层", "所在位", "来源照片", "备注"]
    header_font = Font(bold=True, color="FFFFFF")
    header_fill = PatternFill("solid", fgColor="4472C4")
    for column, header in enumerate(headers, start=1):
        cell = sheet.cell(row=1, column=column, value=header)
        cell.font = header_font
        cell.fill = header_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")
    for row_index, item in enumerate(rows, start=2):
        values = [item.sheet_no, item.row, item.col, item.source_image, item.note]
        for column, value in enumerate(values, start=1):
            sheet.cell(row=row_index, column=column, value=value)
    for column in range(1, len(headers) + 1):
        sheet.column_dimensions[get_column_letter(column)].width = 16
    sheet.freeze_panes = "A2"
    sheet.auto_filter.ref = f"A1:{get_column_letter(len(headers))}{len(rows) + 1}"

    if failures:
        failure_sheet = workbook.create_sheet("识别失败清单")
        failure_sheet.append(["来源照片", "失败类型", "失败原因"])
        for item in failures:
            failure_sheet.append(
                [
                    item.image_name,
                    {
                        "rate_limited": "限流（稍后重试）",
                        "other": "其他",
                        "quality": "照片质量",
                    }.get(item.kind, item.kind),
                    item.reason,
                ]
            )
        failure_sheet.column_dimensions["A"].width = 28
        failure_sheet.column_dimensions["B"].width = 20
        failure_sheet.column_dimensions["C"].width = 48

    if summary:
        summary_sheet = workbook.create_sheet("识别总结")
        summary_sheet.cell(row=1, column=1, value=summary)
        summary_sheet.column_dimensions["A"].width = 80

    workbook.save(target)
    return target


__all__ = [
    "build_excel_filename",
    "is_safe_excel_filename",
    "write_recognition_excel",
]
