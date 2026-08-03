"""批量直写快速路径测试：一次模型调用写入全部目标文件。"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from backend.services.agent.resource_coordinator import WorkspaceResourceCoordinator
from backend.services.agent.work_models import WorkItem
from backend.services.agent.work_state import WorkWorkerState
from backend.services.agent.work_worker import _try_batch_write, _try_write_then_review
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.types import LlmUsage


async def _noop(*_args, **_kwargs) -> None:
    """测试用空回调。"""


@pytest.mark.asyncio
async def test_batch_write_applies_all_files_in_one_call(tmp_path, monkeypatch) -> None:
    """模型一次返回全部 edit 操作时，所有目标文件一次性落盘。"""

    (tmp_path / "a.ts").write_text("OLD_A", encoding="utf-8")
    (tmp_path / "b.ts").write_text("OLD_B", encoding="utf-8")

    async def fake_complete(**_kwargs):
        return (
            json.dumps(
                {
                    "action": "edit",
                    "workId": "W001",
                    "summary": "一次性写入",
                    "operations": [
                        {
                            "type": "write",
                            "path": "a.ts",
                            "content": "NEW_A",
                            "reason": "更新",
                        },
                        {
                            "type": "write",
                            "path": "b.ts",
                            "content": "NEW_B",
                            "reason": "更新",
                        },
                    ],
                }
            ),
            LlmUsage(prompt=10, completion=2, total=12),
            SimpleNamespace(name="Batch Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.work_worker.GATEWAY.complete",
        fake_complete,
    )
    state = WorkWorkerState()
    work = WorkItem(
        id="W001",
        title="修改 A 和 B",
        objective="更新两个目标文件",
        target_files=["a.ts", "b.ts"],
        execution_type="coding",
    )

    result, _reason = await _try_batch_write(
        root=tmp_path,
        work=work,
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
        coordinator=WorkspaceResourceCoordinator(),
        state=state,
        emit=_noop,
        checkpoint=_noop,
        slot=1,
    )

    assert result is not None, f"TRANSCRIPT: {state.transcript[-5:]}"
    assert result.succeeded is True
    assert (tmp_path / "a.ts").read_text("utf-8") == "NEW_A"
    assert (tmp_path / "b.ts").read_text("utf-8") == "NEW_B"
    assert sorted(state.changed_files) == ["a.ts", "b.ts"]


@pytest.mark.asyncio
async def test_batch_write_falls_back_when_model_returns_read(
    tmp_path,
    monkeypatch,
) -> None:
    """模型没有配合批量写入时返回 None，交给常规多轮循环。"""

    (tmp_path / "a.ts").write_text("OLD_A", encoding="utf-8")

    async def fake_complete(**_kwargs):
        return (
            json.dumps({"action": "read", "workId": "W001", "paths": ["a.ts"]}),
            LlmUsage(prompt=10, completion=2, total=12),
            SimpleNamespace(name="Batch Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.work_worker.GATEWAY.complete",
        fake_complete,
    )
    state = WorkWorkerState()
    work = WorkItem(
        id="W001",
        title="修改 A",
        objective="更新目标文件",
        target_files=["a.ts"],
        execution_type="coding",
    )

    result, reason = await _try_batch_write(
        root=tmp_path,
        work=work,
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
        coordinator=WorkspaceResourceCoordinator(),
        state=state,
        emit=_noop,
        checkpoint=_noop,
        slot=1,
    )

    assert result is None
    assert reason == "model_skipped"
    assert (tmp_path / "a.ts").read_text("utf-8") == "OLD_A"
    assert "BATCH WRITE SKIPPED" in state.transcript[-1]


@pytest.mark.asyncio
async def test_write_then_review_completes_generation_work(
    tmp_path, monkeypatch
) -> None:
    """生成类 Work：批量直写未配合时，分块写入 + 单次审查直接完成，不进多轮循环。"""

    calls = 0

    async def fake_complete(**_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            # 分块直写成功
            return (
                json.dumps(
                    {
                        "action": "edit",
                        "workId": "W001",
                        "summary": "生成",
                        "operations": [
                            {
                                "type": "write",
                                "path": "a.ts",
                                "content": "DATA = 1\n",
                                "reason": "生成",
                            }
                        ],
                    }
                ),
                LlmUsage(prompt=10, completion=2, total=12),
                SimpleNamespace(name="Batch Model"),
            )
        # 审查通过
        return (
            json.dumps({"verdict": "complete", "summary": "写入内容满足验收"}),
            LlmUsage(prompt=10, completion=2, total=12),
            SimpleNamespace(name="Review Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.work_worker.GATEWAY.complete",
        fake_complete,
    )
    state = WorkWorkerState()
    work = WorkItem(
        id="W001",
        title="生成 mock 数据",
        objective="补齐目标文件",
        target_files=["a.ts"],
        execution_type="coding",
    )

    result = await _try_write_then_review(
        root=tmp_path,
        work=work,
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
        coordinator=WorkspaceResourceCoordinator(),
        state=state,
        emit=_noop,
        checkpoint=_noop,
        slot=1,
    )

    assert result is not None
    assert result.succeeded is True
    assert (tmp_path / "a.ts").read_text("utf-8") == "DATA = 1\n"
    assert calls == 2


@pytest.mark.asyncio
async def test_write_then_review_cannot_fix_goes_to_planner(
    tmp_path, monkeypatch
) -> None:
    """审查判定任务不可行时，以 guard 失败交回 Planner，而不是继续烧 token。"""

    calls = 0

    async def fake_complete(**_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return (
                json.dumps(
                    {
                        "action": "edit",
                        "workId": "W001",
                        "summary": "生成",
                        "operations": [
                            {
                                "type": "write",
                                "path": "b.ts",
                                "content": "B = 1\n",
                                "reason": "生成",
                            }
                        ],
                    }
                ),
                LlmUsage(prompt=10, completion=2, total=12),
                SimpleNamespace(name="Batch Model"),
            )
        return (
            json.dumps(
                {
                    "verdict": "cannot_fix",
                    "reason": "验收标准与目标文件冲突",
                }
            ),
            LlmUsage(prompt=10, completion=2, total=12),
            SimpleNamespace(name="Review Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.work_worker.GATEWAY.complete",
        fake_complete,
    )
    state = WorkWorkerState()
    work = WorkItem(
        id="W002",
        title="补齐契约",
        objective="生成 schema",
        target_files=["b.ts"],
        execution_type="coding",
    )

    result = await _try_write_then_review(
        root=tmp_path,
        work=work,
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
        coordinator=WorkspaceResourceCoordinator(),
        state=state,
        emit=_noop,
        checkpoint=_noop,
        slot=1,
    )

    assert result is not None
    assert result.succeeded is False
    assert result.failure_kind == "guard"
    assert calls == 2


@pytest.mark.asyncio
async def test_write_then_review_generates_all_files_when_targets_empty(
    tmp_path, monkeypatch
) -> None:
    """空 targetFiles 的生成类 Work：模型自命名一次性创建全部文件，再审查完成。"""

    calls = 0

    async def fake_complete(**_kwargs):
        nonlocal calls
        calls += 1
        if calls == 1:
            return (
                json.dumps(
                    {
                        "action": "edit",
                        "workId": "W001",
                        "summary": "创建全部文件",
                        "operations": [
                            {
                                "type": "write",
                                "path": "src/gen/page.tsx",
                                "content": "export const Page = 1;\n",
                                "reason": "生成",
                            }
                        ],
                    }
                ),
                LlmUsage(prompt=10, completion=2, total=12),
                SimpleNamespace(name="Batch Model"),
            )
        return (
            json.dumps({"verdict": "complete", "summary": "页面已创建"}),
            LlmUsage(prompt=10, completion=2, total=12),
            SimpleNamespace(name="Review Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.work_worker.GATEWAY.complete",
        fake_complete,
    )
    state = WorkWorkerState()
    work = WorkItem(
        id="W001",
        title="生成电商小程序页面",
        objective="创建全部页面文件",
        target_files=[],
        execution_type="coding",
    )

    result = await _try_write_then_review(
        root=tmp_path,
        work=work,
        preferred_model_id="auto",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
        coordinator=WorkspaceResourceCoordinator(),
        state=state,
        emit=_noop,
        checkpoint=_noop,
        slot=1,
    )

    assert result is not None
    assert result.succeeded is True
    assert (tmp_path / "src" / "gen" / "page.tsx").read_text("utf-8") == (
        "export const Page = 1;\n"
    )
    assert calls == 2
