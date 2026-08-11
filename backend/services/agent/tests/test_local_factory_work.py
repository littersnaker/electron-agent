"""Software Factory 本地执行路径测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.agent.harness import ProjectHarness
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import WorkWorkerState
from backend.services.agent.worker.factory_work import execute_factory_work


@pytest.mark.asyncio
async def test_artifact_work_generates_data_layer_without_worker_llm(tmp_path: Path) -> None:
    """固定领域产物应由本地 Factory 生成，Worker Token 保持为零。"""

    (tmp_path / "package.json").write_text(
        '{"dependencies":{"react":"19.0.0"}}',
        "utf-8",
    )
    (tmp_path / "src").mkdir()
    events: list[dict[str, object]] = []

    async def emit(_: str, payload: dict[str, object]) -> None:
        """记录本地 Factory 生命周期事件。"""

        events.append(payload)

    async def checkpoint() -> None:
        """测试使用无需持久化的 Checkpoint。"""

    state = WorkWorkerState()
    result = await execute_factory_work(
        root=tmp_path,
        request_text="生成电商小程序 Mock API 和统一数据源",
        work=WorkItem(
            "SF002",
            "生成 Mock、OpenAPI 与可切换数据源",
            "调用 factory generate",
            execution_type="artifact",
        ),
        harness=ProjectHarness(framework="React", source_root="src"),
        state=state,
        emit=emit,
        checkpoint=checkpoint,
        slot=1,
    )

    assert result.succeeded is True
    assert state.usage.total == 0
    assert (tmp_path / "src/features/commerce/data-source.ts").is_file()
    assert any(item.get("status") == "completed" for item in events)

    # 页面尚未绑定时整体 validate 会失败，但恢复任务仍应复用已生成的数据层，
    # 不能再次覆盖或把生成 Work 错误标记为失败。
    resumed = await execute_factory_work(
        root=tmp_path,
        request_text="生成电商小程序 Mock API 和统一数据源",
        work=WorkItem(
            "SF002",
            "生成 Mock、OpenAPI 与可切换数据源",
            "调用 factory generate",
            execution_type="artifact",
        ),
        harness=ProjectHarness(framework="React", source_root="src"),
        state=state,
        emit=emit,
        checkpoint=checkpoint,
        slot=1,
    )
    assert resumed.succeeded is True
    assert "复用" in resumed.summary
