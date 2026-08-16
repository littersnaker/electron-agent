"""图片识别 Agent 单元测试：预处理、识别解析、LLM 整理、Excel 导出、SSE 编排。"""

from __future__ import annotations

import base64
import io
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.services.glm46v.client import GLM46VSettings
from backend.services.image.excel import (
    build_excel_filename,
    is_safe_excel_filename,
    write_recognition_excel,
)
from backend.services.image.models import (
    ImageRecognitionFailure,
    SheetRecognition,
)
from backend.services.image.preprocess import preprocess_image
from backend.services.image.recognition import (
    build_recognition_prompt,
    classify_failure_kind,
    merge_recognitions,
    recognize_single_image,
)
from backend.services.image.structuring import _deterministic_rows, structure_rows
from backend.services.llm.credentials import LlmCredentials


def tiny_png_base64() -> str:
    return base64.b64encode(
        base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
    ).decode("ascii")


def _make_png(width: int, height: int) -> str:
    from PIL import Image

    buffer = io.BytesIO()
    Image.new("RGB", (width, height), (220, 220, 220)).save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


class FakeClient:
    def __init__(self, content: str = "") -> None:
        self.content = content
        self.calls: list[str] = []

    @property
    def settings(self) -> GLM46VSettings:
        return GLM46VSettings(api_key="fake", endpoint="https://example.test")

    async def analyze_images(self, images, *, prompt: str, max_tokens: int = 6144):
        self.calls.append(prompt)
        if not self.content:
            raise RuntimeError("mock 识别失败")
        return {"model": "glm-4.6v-flash", "content": self.content, "usage": {}}


# ---------- preprocess ----------


def test_preprocess_enhances_and_upscales() -> None:
    image = preprocess_image(
        name="shelf.png",
        mime_type="image/png",
        data=_make_png(80, 60),
        max_image_mb=20,
    )
    assert image.mime_type == "image/jpeg"
    assert image.size_bytes > 0
    from PIL import Image

    decoded = Image.open(io.BytesIO(base64.b64decode(image.data)))
    assert decoded.width == 160  # 2x 放大
    assert decoded.height == 120
    assert image.name == "shelf.png"


def test_preprocess_rejects_invalid_data() -> None:
    from backend.services.glm46v.client import GLM46VError

    with pytest.raises(GLM46VError):
        preprocess_image(
            name="bad.png",
            mime_type="image/png",
            data="not-base64-!",
            max_image_mb=20,
        )


# ---------- recognition ----------


def test_build_recognition_prompt_contains_fixed_rules() -> None:
    prompt = build_recognition_prompt("shelf_a.jpg")
    assert "从上到下" in prompt
    assert "只输出贴有图纸的货位" in prompt
    assert "shelf_a.jpg" in prompt


@pytest.mark.asyncio
async def test_recognize_single_image_parses_pipe_rows() -> None:
    client = FakeClient("003|第1层|第2位|\n005|第2层|第3位|编号无法辨认")
    rows, summary, error = await recognize_single_image(
        image=SimpleNamespace(name="shelf_a.jpg"),
        client=client,
        prompt="识别",
    )
    assert error is None
    assert len(rows) == 2
    assert rows[0].sheet_no == "003"
    assert rows[0].row == "第1层"
    assert rows[0].col == "第2位"
    assert rows[1].note == "编号无法辨认"
    assert rows[0].source_image == "shelf_a.jpg"
    assert "识别到 2 个图纸编号" in summary


@pytest.mark.asyncio
async def test_recognize_single_image_parses_real_glm_output() -> None:
    """GLM-4.6V 真实输出：编号带方括号、多条记录挤在一行、空格分隔。"""

    content = (
        "[325]|[第1层|第1位| [89]|[第1层|第2位| [302]|[第1层|第3位| "
        "[386]|[第1层|第4位| [88]|[第1层|第5位| [734]|[第1层|第6位|"
    )
    client = FakeClient(content)
    rows, _summary, error = await recognize_single_image(
        image=SimpleNamespace(name="shelf_a.jpg"),
        client=client,
        prompt="识别",
    )
    assert error is None
    assert len(rows) == 6
    assert [item.sheet_no for item in rows] == ["325", "89", "302", "386", "88", "734"]
    assert rows[0].row == "第1层"
    assert rows[0].col == "第1位"
    assert rows[-1].col == "第6位"


@pytest.mark.asyncio
async def test_recognize_single_image_parses_note_after_position() -> None:
    """位号之后出现的“编号无法辨认”应进入备注而非编号。"""

    content = "005|第2层|第3位|编号无法辨认\n[008]|[第2层|第4位|"
    client = FakeClient(content)
    rows, _summary, error = await recognize_single_image(
        image=SimpleNamespace(name="shelf_b.jpg"),
        client=client,
        prompt="识别",
    )
    assert error is None
    assert len(rows) == 2
    assert rows[0].sheet_no == "005"
    assert rows[0].note == "编号无法辨认"
    assert rows[1].sheet_no == "008"
    assert rows[1].note == ""


@pytest.mark.asyncio
async def test_recognize_single_image_degrades_on_failure() -> None:
    client = FakeClient(content="")  # analyze_images 抛 RuntimeError
    rows, _summary, error = await recognize_single_image(
        image=SimpleNamespace(name="shelf_b.jpg"),
        client=client,
        prompt="识别",
    )
    assert rows == []
    assert error is not None
    assert "识别失败" in error


@pytest.mark.asyncio
async def test_recognize_single_image_handles_no_shelf() -> None:
    client = FakeClient("未检测到货架图纸")
    rows, summary, error = await recognize_single_image(
        image=SimpleNamespace(name="shelf_c.jpg"),
        client=client,
        prompt="识别",
    )
    assert rows == []
    assert error is None  # 未检测到图纸不算失败
    assert "未检测到货架图纸" in summary


def test_merge_recognitions_keeps_successes_and_failures() -> None:
    rows, failures, summaries = merge_recognitions(
        [
            (
                "a.jpg",
                [SheetRecognition("001", "第1层", "第1位", "a.jpg")],
                None,
            ),
            ("b.jpg", [], "视觉识别失败：mock"),
            ("c.jpg", [], "智谱 API 请求失败（HTTP 429）：访问量过大，请稍后再试"),
        ]
    )
    assert len(rows) == 1
    assert len(failures) == 2
    assert failures[0].image_name == "b.jpg"
    assert failures[0].kind == "other"
    assert "mock" in failures[0].reason
    assert failures[1].kind == "rate_limited"  # 429 限流单独分类
    assert len(summaries) == 1  # 失败张不计入总结


def test_classify_failure_kind() -> None:
    assert classify_failure_kind("HTTP 429 访问量过大") == "rate_limited"
    assert classify_failure_kind("限流，请稍后再试") == "rate_limited"
    assert classify_failure_kind("图片无法解码") == "other"


# ---------- structuring ----------


def test_deterministic_rows_sorts_and_dedups() -> None:
    rows = _deterministic_rows(
        [
            SheetRecognition("010", "第2层", "第1位", "a.jpg"),
            SheetRecognition("002", "第1层", "第3位", "a.jpg"),
            SheetRecognition("010", "第2层", "第1位", "b.jpg"),  # 重复
        ]
    )
    assert [item.sheet_no for item in rows] == ["002", "010"]
    assert len(rows) == 2


@pytest.mark.asyncio
async def test_structure_rows_falls_back_without_credentials() -> None:
    rows = await structure_rows(
        credentials=None,
        preferred_model_id="auto",
        raw_rows=[
            SheetRecognition("002", "第1层", "第3位", "a.jpg"),
            SheetRecognition("001", "第1层", "第1位", "a.jpg"),
        ],
    )
    assert [item.sheet_no for item in rows] == ["001", "002"]  # 确定性排序


@pytest.mark.asyncio
async def test_structure_rows_uses_llm_when_available(monkeypatch) -> None:
    from backend.services.image import structuring

    captured: dict[str, object] = {}

    async def fake_complete(*, preferred_model_id, credentials, messages, **kwargs):
        captured["model"] = preferred_model_id
        return (
            '[{"sheetNo":"003","row":"第1层","col":"第2位","sourceImage":"a.jpg","note":""}]',
            object(),
            "fake-model",
        )

    monkeypatch.setattr(structuring.GATEWAY, "complete", fake_complete)
    credentials = LlmCredentials(values={"qwen": "k"})
    rows = await structure_rows(
        credentials=credentials,
        preferred_model_id="qwen-test",
        raw_rows=[
            SheetRecognition("003", "第1层", "第2位", "a.jpg"),
        ],
    )
    assert captured["model"] == "qwen-test"
    assert len(rows) == 1
    assert rows[0].sheet_no == "003"


# ---------- excel ----------


def test_excel_filename_safety() -> None:
    assert is_safe_excel_filename("货架图纸识别_20260816_120000.xlsx")
    assert not is_safe_excel_filename("../evil.xlsx")
    assert not is_safe_excel_filename("a/b.xlsx")


def test_clean_cell_text_strips_illegal_xml_characters() -> None:
    """GLM 识别文本夹杂的控制字符会让 xlsx 损坏，必须清洗。"""

    from backend.services.image.excel import clean_cell_text

    dirty = "编号\x00无法辨认\x08\n换行\x1f"
    cleaned = clean_cell_text(dirty)
    assert "\x00" not in cleaned
    assert "\x08" not in cleaned
    assert "\x1f" not in cleaned
    assert "编号无法辨认 换行" == cleaned


def test_write_recognition_excel_roundtrip(tmp_path: Path) -> None:
    from openpyxl import load_workbook

    target = write_recognition_excel(
        directory=tmp_path,
        rows=[
            SheetRecognition("003\x00", "第1层", "第2位", "shelf_a.jpg", ""),
            SheetRecognition("005", "第2层", "第3位", "shelf_a.jpg", "编号无法辨认", rank="排2"),
        ],
        failures=[ImageRecognitionFailure("shelf_b.jpg", "视觉识别失败：mock")],
        summary="共识别 2 个图纸编号",
    )
    assert target.is_file()
    workbook = load_workbook(target)
    assert workbook.sheetnames == ["图纸编号", "识别失败清单", "识别总结"]
    sheet = workbook["图纸编号"]
    assert sheet["A1"].value == "图纸编号"
    assert sheet["A2"].value == "003"  # 清洗掉控制字符
    assert sheet["D2"].value in (None, "")  # 排位列：单标签无排位为空
    assert sheet["E2"].value == "shelf_a.jpg"  # 来源照片列
    assert sheet["D3"].value == "排2"  # 叠放排位
    failure_sheet = workbook["识别失败清单"]
    assert failure_sheet["A2"].value == "shelf_b.jpg"
    assert workbook["识别总结"]["A1"].value == "共识别 2 个图纸编号"


def test_build_excel_filename_format() -> None:
    name = build_excel_filename()
    assert name.startswith("货架图纸识别_")
    assert name.endswith(".xlsx")


# ---------- service SSE ----------


class FakeNoFailClient:
    """固定返回一条识别记录，用于验证 SSE 帧序列。"""

    @property
    def settings(self) -> GLM46VSettings:
        return GLM46VSettings(api_key="fake", endpoint="https://example.test")

    async def analyze_images(self, images, *, prompt: str, max_tokens: int = 6144):
        return {
            "model": "glm-4.6v-flash",
            "content": "003|第1层|第2位|",
            "usage": {},
        }


@pytest.mark.asyncio
async def test_stream_image_recognition_emits_sse_frames(monkeypatch, tmp_path) -> None:
    from backend.services.image import service as image_service

    def fake_settings(_credentials=None):
        return SimpleNamespace(max_image_mb=20)

    monkeypatch.setattr(
        image_service,
        "GLM46VSettings",
        type("FakeSettings", (), {"from_credentials": staticmethod(fake_settings)}),
    )

    def fake_preprocess(*, name, mime_type, data, max_image_mb):
        return SimpleNamespace(name=name, data=data)

    async def fake_recognize(*, image, client, prompt):
        return (
            [SheetRecognition("003", "第1层", "第2位", image.name)],
            "识别到 1 个编号",
            None,
        )

    async def fake_structure(*, credentials, preferred_model_id, raw_rows):
        return raw_rows

    def fake_write(*, directory, rows, failures, summary):
        return tmp_path / "货架图纸识别_test.xlsx"

    monkeypatch.setattr(image_service, "GLM46VClient", lambda settings: FakeNoFailClient())
    monkeypatch.setattr(image_service, "preprocess_image", fake_preprocess)
    monkeypatch.setattr(image_service, "recognize_single_image", fake_recognize)
    monkeypatch.setattr(image_service, "structure_rows", fake_structure)
    monkeypatch.setattr(image_service, "write_recognition_excel", fake_write)

    payload = SimpleNamespace(
        attachments=[
            SimpleNamespace(
                name="shelf_a.jpg",
                mime_type="image/jpeg",
                data="data:image/jpeg;base64,AAAA",
            )
        ]
    )
    frames: list[str] = []
    async for frame in image_service.stream_image_recognition(
        body=payload,
        credentials=None,
        preferred_model_id="auto",
        session_id="sess-1",
    ):
        frames.append(frame)

    joined = "\n".join(frames)
    assert "IMAGE_RESULT" in joined
    assert "TEXT" in joined
    assert "done" in joined
    assert "003" in joined


@pytest.mark.asyncio
async def test_stream_image_recognition_handles_missing_images() -> None:
    from backend.services.image import service as image_service

    payload = SimpleNamespace(attachments=[])
    frames: list[str] = []
    async for frame in image_service.stream_image_recognition(
        body=payload,
        credentials=None,
        preferred_model_id="auto",
        session_id="sess-1",
    ):
        frames.append(frame)
    assert any("没有收到图片附件" in frame for frame in frames)
