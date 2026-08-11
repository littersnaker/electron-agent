"""Worker 系统提示词的执行策略约束测试。

覆盖最近一次日志分析暴露的"小步循环 + 大输出重写"问题的提示词修复：
单轮多组 operations、禁止 edit 后 read 验证、禁止整文件 write 重写已存在文件。
"""

from __future__ import annotations

from backend.services.agent.harness.models import ProjectHarness
from backend.services.agent.work_models import WorkItem
from backend.services.agent.work_state import WorkWorkerState
from backend.services.agent.work_worker import _worker_prompt


def _work() -> WorkItem:
    return WorkItem(
        id="W001",
        title="分类页移动端适配",
        objective="把固定 px 改为 rpx",
        acceptance_criteria=["触控区不小于 88rpx"],
        target_files=["src/pages/category/index.scss"],
    )


def test_worker_prompt_forbids_small_step_edit_loop() -> None:
    """提示词必须禁止"改一处→read 验证→再改下一处"的小步循环。"""

    prompt = _worker_prompt(
        _work(),
        ProjectHarness(),
        "auto_edit",
        WorkWorkerState(),
    )

    assert "一次 edit 必须用多组 operations" in prompt
    assert "小步循环" in prompt


def test_worker_prompt_forbids_read_after_edit() -> None:
    """提示词必须禁止 edit 写入后 read 刚写过的文件验证。"""

    prompt = _worker_prompt(_work(), ProjectHarness(), "auto_edit")

    assert "edit 写入成功后不要 read 刚写过的文件验证" in prompt
    assert "直接 complete_work" in prompt


def test_worker_prompt_forbids_full_file_rewrite() -> None:
    """提示词必须禁止对已存在文件整文件 write 重写，write 仅用于新建。"""

    prompt = _worker_prompt(_work(), ProjectHarness(), "auto_edit")

    assert "write 只用于新建文件" in prompt
    assert "禁止对已存在文件整文件 write 重写" in prompt


def test_worker_prompt_keeps_factory_and_retry_hints() -> None:
    """既有 factory 提示与重试提示不应被新约束破坏。"""

    work = _work()
    state = WorkWorkerState(attempt_number=2)
    prompt = _worker_prompt(
        work,
        ProjectHarness(),
        "auto_edit",
        state,
    )

    assert "CURRENT WORK:" in prompt
    assert "当前是重试尝试" in prompt
