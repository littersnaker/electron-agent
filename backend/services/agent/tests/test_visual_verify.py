"""视觉验证：截图 Review 网关调用、dev server 白名单、review 前端标记测试。"""

from __future__ import annotations

import base64
from pathlib import Path

import pytest

from backend.services.agent.loop.final_quality import _task_summary
from backend.services.agent.shared.work_state import WorkWorkerState
from backend.services.llm.credentials import LlmCredentials
from backend.services.visual.dev_server import resolve_dev_command
from backend.services.visual.verify import ReviewFrame, build_review_prompt, review_screenshots


def _sample_base64() -> str:
    """构造一张 1x1 透明 PNG 的 Base64。"""

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk"
        "YPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="
    )
    return base64.b64encode(png).decode("ascii")


def test_resolve_dev_command_allows_only_dev(tmp_path: Path) -> None:
    """dev server 通道只放行白名单 dev 脚本，非 dev 脚本拒绝。"""

    (tmp_path / "package.json").write_text('{"scripts": {"dev": "vite"}}', encoding="utf-8")
    assert resolve_dev_command(tmp_path) == ["pnpm", "run", "dev"]

    # 没有 dev 脚本的项目应拒绝。
    empty = tmp_path / "empty"
    empty.mkdir()
    (empty / "package.json").write_text('{"scripts": {"build": "tsc"}}', encoding="utf-8")
    with pytest.raises(ValueError, match="没有定义 dev 脚本"):
        resolve_dev_command(empty)

    # 聚合/串联命令应拒绝（安全边界：只放行单条 dev 命令）。
    chained = tmp_path / "chained"
    chained.mkdir()
    (chained / "package.json").write_text(
        '{"scripts": {"dev": "pnpm clean && vite"}}', encoding="utf-8"
    )
    with pytest.raises(ValueError, match="串联或重定向"):
        resolve_dev_command(chained)


def test_build_review_prompt_contains_task_and_frames() -> None:
    """Review prompt 应包含任务目标与帧数说明。"""

    prompt = build_review_prompt("实现购物车", 3)
    assert "实现购物车" in prompt
    assert "3" in prompt


@pytest.mark.asyncio
async def test_review_screenshots_returns_error_without_any_key() -> None:
    """未配置任何供应商 Key 时应返回结构化错误，不抛异常。"""

    result = await review_screenshots(
        frames=[ReviewFrame(data=_sample_base64(), mime_type="image/png")],
        task_summary="核对页面",
        credentials=LlmCredentials(values={}),
    )

    assert result.get("ok") is False
    assert "Key" in (result.get("error") or "")


def test_task_summary_extracts_objective() -> None:
    """review 的任务摘要应从 Worker 状态提取 objective。"""

    state = WorkWorkerState()
    state.work_context = {"objective": "实现首页轮播图"}
    assert _task_summary({"w1": state}) == "实现首页轮播图"

    empty = WorkWorkerState()
    assert _task_summary({"w1": empty}) == "前端页面改动"
