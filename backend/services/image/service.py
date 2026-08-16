"""图片识别 Agent 业务编排：预处理 → GLM 识别 → LLM 整理 → Excel 导出。

固定式流水线，不经过 planner/worklist。全程以 SSE 事件流输出阶段进度；
任意单张照片失败只降级记入失败清单，不中断整条流水线。
"""

from __future__ import annotations

import logging
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

from backend.services.glm46v.client import GLM46VClient, GLM46VSettings, ImageInput
from backend.services.image.excel import write_recognition_excel
from backend.services.image.models import (
    ImageRecognitionFailure,
    RecognitionOutcome,
    SheetRecognition,
)
from backend.services.image.preprocess import preprocess_image
from backend.services.image.recognition import (
    build_recognition_prompt,
    merge_recognitions,
    recognize_single_image,
)
from backend.services.image.structuring import structure_rows
from backend.services.llm.credentials import LlmCredentials
from backend.utils.sse import sse_packet

LOGGER = logging.getLogger(__name__)

MAX_IMAGES_PER_REQUEST = 8


def _attachment_values(attachment: object, *names: str) -> str:
    for name in names:
        value = getattr(attachment, name, None)
        if value is not None and str(value).strip():
            return str(value).strip()
    return ""


def _is_image_attachment(attachment: object) -> bool:
    mime_type = _attachment_values(attachment, "mime_type", "mimeType", "type")
    return mime_type.lower().startswith("image/")


def collect_image_attachments(payload: object) -> list[object]:
    """提取请求中的图片附件（与 GLM 附件识别保持同一套规则）。"""

    attachments = getattr(payload, "attachments", None)
    if not isinstance(attachments, list):
        return []
    return [item for item in attachments if _is_image_attachment(item)]


def excel_directory(session_id: str) -> Path:
    """返回本会话的 Excel 落盘目录（临时目录，可安全下载）。"""

    return Path(tempfile.gettempdir()) / "image" / session_id


def excel_download_url(session_id: str, file_name: str) -> str:
    """生成前端可下载的 Excel URL。"""

    return f"/api/image/asset/{session_id}/{file_name}"


async def stream_image_recognition(
    *,
    body: object,
    credentials: LlmCredentials | None,
    preferred_model_id: str,
    session_id: str,
) -> AsyncIterator[str]:
    """执行图片识别流水线并产出 SSE 事件流。

    事件类型：
    - ``STATUS``：阶段进度（预处理/识别中/整理中/生成Excel/完成）
    - ``TEXT``：GLM 汇总总结
    - ``IMAGE_RESULT``：结构化识别行、失败清单与 Excel 下载信息
    """

    settings = GLM46VSettings.from_credentials(credentials)
    client = GLM46VClient(settings)

    attachments = collect_image_attachments(body)
    if not attachments:
        yield sse_packet("STATUS", {"stage": "error", "detail": "没有收到图片附件。"})
        return
    if len(attachments) > MAX_IMAGES_PER_REQUEST:
        yield sse_packet(
            "STATUS",
            {
                "stage": "error",
                "detail": f"单次最多识别 {MAX_IMAGES_PER_REQUEST} 张照片，当前 {len(attachments)} 张。",
            },
        )
        return

    outcome = RecognitionOutcome()

    # ① 预处理：清晰度增强 + 放大。失败张直接记入失败清单，不进入识别。
    yield sse_packet(
        "STATUS",
        {
            "stage": "preprocess",
            "detail": f"正在增强 {len(attachments)} 张照片清晰度并放大…",
        },
    )
    prepared: list[tuple[str, ImageInput]] = []
    for attachment in attachments:
        name = _attachment_values(attachment, "name") or "attachment.jpg"
        mime_type = _attachment_values(
            attachment, "mime_type", "mimeType", "type"
        ) or "image/png"
        data = _attachment_values(attachment, "data_url", "dataUrl", "data")
        if not data:
            outcome.failures.append(
                ImageRecognitionFailure(name, "图片没有可用的 Base64 数据")
            )
            continue
        try:
            image = preprocess_image(
                name=name,
                mime_type=mime_type,
                data=data,
                max_image_mb=settings.max_image_mb,
            )
        except Exception as exc:  # noqa: BLE001 - 单张预处理失败降级。
            LOGGER.warning("照片 %s 预处理失败：%s", name, exc)
            outcome.failures.append(
                ImageRecognitionFailure(name, f"预处理失败：{exc}")
            )
            continue
        prepared.append((name, image))

    if not prepared:
        yield sse_packet("IMAGE_RESULT", outcome.to_json())
        yield sse_packet(
            "STATUS",
            {"stage": "done", "detail": "没有可识别的照片，请重新上传后重试。"},
        )
        return

    # ② 逐张串行 GLM 识别（共享层已全局节流）。
    yield sse_packet(
        "STATUS",
        {
            "stage": "recognizing",
            "detail": f"正在逐张识别 {len(prepared)} 张照片（每张约 5-10 秒）…",
        },
    )
    per_image: list[tuple[str, list[SheetRecognition], str | None]] = []
    for index, (name, image) in enumerate(prepared, start=1):
        rows, error = await recognize_single_image(
            image=image,
            client=client,
            prompt=build_recognition_prompt(image_names=name),
        )
        per_image.append((name, rows, error))
        if error is None:
            yield sse_packet(
                "STATUS",
                {
                    "stage": "recognizing",
                    "detail": f"已识别 {index}/{len(prepared)}：{name} 找到 {len(rows)} 个编号",
                },
            )
        else:
            yield sse_packet(
                "STATUS",
                {
                    "stage": "recognizing",
                    "detail": f"已识别 {index}/{len(prepared)}：{name} 识别失败，已跳过",
                },
            )

    rows, failures, summaries = merge_recognitions(per_image)
    outcome.failures.extend(failures)
    outcome.rows = rows
    outcome.summary = "\n".join(summaries) if summaries else "未识别到任何图纸编号。"

    # ③ 文本模型整理成标准结构（失败自动回退确定性排序）。
    if rows:
        yield sse_packet(
            "STATUS",
            {"stage": "structuring", "detail": "正在整理识别结果…"},
        )
        outcome.rows = await structure_rows(
            credentials=credentials,
            preferred_model_id=preferred_model_id,
            raw_rows=rows,
        )

    # ④ 生成 Excel 并落盘。
    yield sse_packet(
        "STATUS",
        {"stage": "excel", "detail": "正在生成 Excel 表格…"},
    )
    file_name = ""
    try:
        directory = excel_directory(session_id)
        target = write_recognition_excel(
            directory=directory,
            rows=outcome.rows,
            failures=outcome.failures,
            summary=outcome.summary,
        )
        file_name = target.name
        outcome.excel_file_name = file_name
        outcome.excel_download_url = excel_download_url(session_id, file_name)
    except Exception as exc:  # noqa: BLE001 - Excel 失败不影响已完成的识别结果展示。
        LOGGER.exception("生成 Excel 失败")
        outcome.summary = (
            f"{outcome.summary}\nExcel 导出失败：{exc}"
            if outcome.summary
            else f"Excel 导出失败：{exc}"
        )

    yield sse_packet("TEXT", {"content": outcome.summary})
    yield sse_packet("IMAGE_RESULT", outcome.to_json())
    yield sse_packet(
        "STATUS",
        {
            "stage": "done",
            "detail": (
                f"识别完成：{len(outcome.rows)} 个图纸编号"
                + (f"，{len(outcome.failures)} 张照片需复核" if outcome.failures else "")
            ),
        },
    )


__all__ = [
    "collect_image_attachments",
    "excel_directory",
    "excel_download_url",
    "stream_image_recognition",
]
