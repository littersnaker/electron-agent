"""视觉 Review 服务与接口测试（mock 网关，不联网）。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from backend.services.llm.types import LlmUsage
from backend.services.visual.verify import (
    MAX_REVIEW_FRAMES,
    ReviewFrame,
    build_review_prompt,
    review_screenshots,
)


class _StubGateway:
    """替身网关：记录调用参数，返回可配置的结果或异常。"""

    def __init__(self, *, content: str = "结论：通过", error: Exception | None = None) -> None:
        self.calls: list[dict[str, Any]] = []
        self._content = content
        self._error = error

    async def complete(self, **kwargs: Any):
        self.calls.append(kwargs)
        if self._error is not None:
            raise self._error
        return (
            self._content,
            LlmUsage(prompt=100, completion=20, total=120),
            type("M", (), {"model": "deepseek-v4-flash-vision-exp"})(),
        )


@pytest.mark.asyncio
async def test_review_passes_frames_in_order(monkeypatch) -> None:
    """多帧截图按顺序转成 ImagePart，模型收到正确的候选与消息。"""

    stub = _StubGateway()
    monkeypatch.setattr("backend.services.visual.verify.GATEWAY", stub)
    credentials = object.__new__(type("LlmCredentials", (), {}))  # 替身，仅透传

    frames = [
        ReviewFrame(data=f"frame-{index}".encode().hex(), mime_type="image/jpeg")
        for index in range(3)
    ]
    result = await review_screenshots(
        frames=frames,
        task_summary="重构首页",
        credentials=credentials,  # type: ignore[arg-type]
        model_id="custom:vision-model",
    )

    assert result["ok"] is True
    assert result["model"] == "deepseek-v4-flash-vision-exp"
    assert result["frameCount"] == 3
    call = stub.calls[0]
    assert call["preferred_model_id"] == "custom:vision-model"
    message = call["messages"][0]
    assert "重构首页" in message.content
    assert [part.data for part in message.images] == [
        f"frame-{index}".encode().hex() for index in range(3)
    ]
    assert all(part.mime_type == "image/jpeg" for part in message.images)


@pytest.mark.asyncio
async def test_review_defaults_to_auto_routing(monkeypatch) -> None:
    """不指定模型时应走网关 Auto 路由。"""

    from backend.services.llm.catalog import AUTO_MODEL_ID

    stub = _StubGateway()
    monkeypatch.setattr("backend.services.visual.verify.GATEWAY", stub)

    await review_screenshots(
        frames=[ReviewFrame(data="abc")],
        task_summary="",
        credentials=None,  # type: ignore[arg-type]
    )
    assert stub.calls[0]["preferred_model_id"] == AUTO_MODEL_ID
    # 空任务摘要时 prompt 有兜底文案。
    assert "通用页面质量标准" in stub.calls[0]["messages"][0].content


@pytest.mark.asyncio
async def test_review_caps_frames(monkeypatch) -> None:
    """超过上限的帧应被截断到 MAX_REVIEW_FRAMES。"""

    stub = _StubGateway()
    monkeypatch.setattr("backend.services.visual.verify.GATEWAY", stub)

    frames = [ReviewFrame(data=f"f{index}") for index in range(MAX_REVIEW_FRAMES + 4)]
    result = await review_screenshots(
        frames=frames,
        task_summary="",
        credentials=None,  # type: ignore[arg-type]
    )
    assert result["frameCount"] == MAX_REVIEW_FRAMES
    assert len(stub.calls[0]["messages"][0].images) == MAX_REVIEW_FRAMES


@pytest.mark.asyncio
async def test_review_reports_no_vision_model_hint(monkeypatch) -> None:
    """网关报「不支持图像输入」时应附加配置引导。"""

    stub = _StubGateway(
        error=ValueError("已配置的模型均不支持图像输入，请配置或选择支持 Vision 的模型。")
    )
    monkeypatch.setattr("backend.services.visual.verify.GATEWAY", stub)

    result = await review_screenshots(
        frames=[ReviewFrame(data="abc")],
        task_summary="",
        credentials=None,  # type: ignore[arg-type]
    )
    assert result["ok"] is False
    assert "deepseek-v4-flash-vision-exp" in result["error"]


@pytest.mark.asyncio
async def test_review_empty_frames_short_circuits(monkeypatch) -> None:
    """全空帧不应触发模型调用。"""

    stub = _StubGateway()
    monkeypatch.setattr("backend.services.visual.verify.GATEWAY", stub)

    result = await review_screenshots(
        frames=[ReviewFrame(data="  ")],
        task_summary="",
        credentials=None,  # type: ignore[arg-type]
    )
    assert result["ok"] is False
    assert stub.calls == []


def test_build_review_prompt_contains_frame_count() -> None:
    """prompt 应告知模型截图帧数与任务目标。"""

    prompt = build_review_prompt("实现登录页", 4)
    assert "4" in prompt
    assert "实现登录页" in prompt


def _client(monkeypatch, tmp_path: Path):
    """创建指向临时数据目录的测试客户端。"""

    from backend.core.config import get_settings
    from backend.main import create_app

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    from fastapi.testclient import TestClient

    return TestClient(create_app())


def test_review_endpoint_returns_structured_result(monkeypatch, tmp_path: Path) -> None:
    """API 层应透传 frames 并返回结构化结论。"""

    stub = _StubGateway(content="结论：通过；页面无布局问题")
    monkeypatch.setattr("backend.services.visual.verify.GATEWAY", stub)

    with _client(monkeypatch, tmp_path) as client:
        response = client.post(
            "/api/visual/review",
            json={
                "frames": [
                    {"imageBase64": "aGVsbG8=", "mimeType": "image/jpeg"},
                    {"imageBase64": "d29ybGQ=", "mimeType": "image/jpeg"},
                ],
                "taskSummary": "验证登录页",
                "modelId": "custom:vision",
            },
        )
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert "通过" in payload["content"]
    assert payload["frameCount"] == 2
    call = stub.calls[0]
    assert call["preferred_model_id"] == "custom:vision"
    assert len(call["messages"][0].images) == 2
