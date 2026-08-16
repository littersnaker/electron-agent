"""把逐张 GLM 识别结果整理成统一的图纸编号 Excel 长表数据。

识别产物是不确定长度的自由文本，这里用用户选择的文本模型把全部识别行整理成
标准 JSON 数组，Pydantic 校验后回填；LLM 未配置/失败/输出非法时静默回退到
按编号排序的确定性排列，绝不阻断主流程。
"""

from __future__ import annotations

import logging
from typing import TypeVar

from pydantic import BaseModel

from backend.services.agent.reflection.schema import extract_json_object
from backend.services.image.models import SheetRecognition
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage

LOGGER = logging.getLogger(__name__)

T = TypeVar("T", bound=BaseModel)


class RecognizedRow(BaseModel):
    """LLM 整理后的单行图纸记录。"""

    sheetNo: str
    row: str = ""
    col: str = ""
    sourceImage: str = ""
    note: str = ""


class StructuredRows(BaseModel):
    """LLM 整理后的完整结果。"""

    rows: list[RecognizedRow]


_STRUCTURING_SYSTEM_PROMPT = """你是表格整理助手。下面是一份货架图纸识别结果，每行格式为
“[编号]|[所在层]|[所在位]|[备注]”，也可能包含“未检测到货架图纸”等说明。

请把它整理成 JSON 数组，数组元素字段：
- sheetNo：图纸编号（去掉前导零之外的杂质，如“003”保持“003”）
- row：所在层（如“第1层”）
- col：所在位（如“第2位”）
- sourceImage：来源照片文件名
- note：备注（如“编号无法辨认”），没有则留空字符串
- 空位不要输出；无法辨认编号的货位也要输出，note 标“编号无法辨认”

只输出 JSON 数组本身，不要 Markdown 围栏、不要解释。"""


async def structure_rows(
    *,
    credentials: LlmCredentials | None,
    preferred_model_id: str,
    raw_rows: list[SheetRecognition],
) -> list[SheetRecognition]:
    """用文本模型把识别行整理为标准结构；失败回退确定性排序。"""

    available = bool(credentials is not None and (credentials.values or {}))
    if not available:
        return _deterministic_rows(raw_rows)
    lines = [
        f"{item.sheet_no}|{item.row}|{item.col}|{item.source_image}|{item.note}"
        for item in raw_rows
    ]
    user_prompt = "识别结果如下：\n" + "\n".join(lines)
    try:
        text, _usage, _model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[
                LlmMessage("system", _STRUCTURING_SYSTEM_PROMPT),
                LlmMessage("user", user_prompt),
            ],
            temperature=0.0,
            timeout_seconds=90,
            stall_timeout_seconds=45,
            audit={"agentId": "image:structuring", "agentRole": "image_structuring"},
        )
        payload = extract_json_object(text)
        structured = StructuredRows.model_validate(payload)
        if not structured.rows:
            return _deterministic_rows(raw_rows)
        return [item for item in (_rows_from_model(structured.rows)) if item]
    except Exception as exc:
        LOGGER.warning("图片识别 LLM 整理失败，回退确定性排序：%s", exc)
        return _deterministic_rows(raw_rows)


def _rows_from_model(items: list[RecognizedRow]) -> list[SheetRecognition]:
    """把 LLM 输出转换为内部模型；缺编号的行直接丢弃。"""

    result: list[SheetRecognition] = []
    for item in items:
        sheet_no = (item.sheetNo or "").strip()
        if not sheet_no:
            continue
        result.append(
            SheetRecognition(
                sheet_no=sheet_no,
                row=item.row.strip() or "未知层",
                col=item.col.strip() or "未知位",
                source_image=item.sourceImage.strip(),
                note=item.note.strip(),
            )
        )
    return result


def _deterministic_rows(raw_rows: list[SheetRecognition]) -> list[SheetRecognition]:
    """确定性兜底：按编号排序、去重（同编号同位置保留一条）。"""

    seen: set[tuple[str, str, str]] = set()
    result: list[SheetRecognition] = []
    for item in sorted(
        raw_rows,
        key=lambda entry: (entry.sheet_no, entry.row, entry.col),
    ):
        key = (item.sheet_no, item.row, item.col)
        if key in seen:
            continue
        seen.add(key)
        result.append(item)
    return result


__all__ = ["structure_rows"]
