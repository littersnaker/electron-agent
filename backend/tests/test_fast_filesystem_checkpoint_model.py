"""确定性文件操作与 Checkpoint 切换模型恢复测试。"""

from __future__ import annotations

import pytest

from backend.core.config import get_settings
from backend.schemas.chat import ChatRequest
from backend.services.agent.checkpoint_runtime import plan_from_json, plan_to_json
from backend.services.agent.filesystem_executor import (
    execute_filesystem_operations,
    parse_direct_filesystem_request,
)
from backend.services.agent.loop import stream_autonomous_loop
from backend.services.agent.run_checkpoint import resolve_run_checkpoint
from backend.services.agent.task_planner import CodeTaskPlan
from backend.services.agent.work_models import FileSystemOperation, WorkItem
from backend.services.checkpoints.store import create_checkpoint, get_checkpoint
from backend.services.workspace.database import initialize_database
from backend.services.llm.credentials import LlmCredentials


def _filesystem_plan(*operations: FileSystemOperation) -> CodeTaskPlan:
    """创建只包含本地文件操作的测试计划。"""

    work = WorkItem(
        id="W001",
        title="重命名文件",
        objective="使用本地执行器完成重命名",
        execution_type="filesystem",
        file_operations=list(operations),
        target_files=[
            path
            for operation in operations
            for path in (operation.source_path, operation.target_path)
            if path
        ],
    )
    return CodeTaskPlan(
        raw_request="重命名文件",
        optimized_prompt="直接重命名，不调用大模型",
        objective="完成重命名",
        constraints=[],
        acceptance_criteria=["文件名正确"],
        non_goals=[],
        validation_commands=[],
        works=[work],
    )



def test_direct_rename_request_is_parsed_without_planner(tmp_path) -> None:
    """完整明确的重命名指令可直接转换成本地文件操作。"""

    (tmp_path / "old.ts").write_text("export {};\n", encoding="utf-8")
    operations = parse_direct_filesystem_request(
        tmp_path,
        "把 `old.ts` 重命名为 `src/new.ts`",
    )

    assert len(operations) == 1
    assert operations[0] == FileSystemOperation("rename", "old.ts", "src/new.ts")

def test_filesystem_executor_supports_swap_rename(tmp_path) -> None:
    """交换重命名会通过事务暂存完成，不覆盖任一文件。"""

    (tmp_path / "a.txt").write_text("A", encoding="utf-8")
    (tmp_path / "b.txt").write_text("B", encoding="utf-8")
    result = execute_filesystem_operations(
        tmp_path,
        [
            FileSystemOperation("rename", "a.txt", "b.txt"),
            FileSystemOperation("rename", "b.txt", "a.txt"),
        ],
    )

    assert (tmp_path / "a.txt").read_text("utf-8") == "B"
    assert (tmp_path / "b.txt").read_text("utf-8") == "A"
    assert set(result.changed_paths) == {"a.txt", "b.txt"}


@pytest.mark.asyncio
async def test_filesystem_work_finishes_without_worker_llm(tmp_path, monkeypatch) -> None:
    """纯重命名 Work 不调用 Worker 或最终汇总大模型。"""

    (tmp_path / "old.pending").write_text("page", encoding="utf-8")

    async def fail_if_called(**_kwargs):
        """任何模型调用都说明快速路径失效。"""

        raise AssertionError("确定性文件 Work 不应调用大模型")

    monkeypatch.setattr("backend.services.agent.loop.GATEWAY.complete", fail_if_called)
    result = None
    async for event in stream_autonomous_loop(
        root=tmp_path,
        task_plan=_filesystem_plan(
            FileSystemOperation("rename", "old.pending", "home.tsx")
        ),
        initial_context="",
        preferred_model_id="custom:new-model",
        credentials=LlmCredentials(values={}),
        execution_mode="auto_edit",
    ):
        if event.kind == "result":
            result = event.result

    assert result is not None
    assert result.usage.total == 0
    assert result.worklist["succeeded"] == 1
    assert (tmp_path / "home.tsx").read_text("utf-8") == "page"
    assert not (tmp_path / "old.pending").exists()


def test_checkpoint_roundtrip_preserves_filesystem_operations() -> None:
    """Checkpoint 恢复后仍能识别无需模型的文件操作 Work。"""

    plan = _filesystem_plan(FileSystemOperation("move", "a.ts", "src/a.ts"))
    restored = plan_from_json(plan_to_json(plan))
    work = restored.works[0]

    assert work.execution_type == "filesystem"
    assert work.file_operations[0].type == "move"
    assert work.file_operations[0].source_path == "a.ts"
    assert work.file_operations[0].target_path == "src/a.ts"


@pytest.mark.asyncio
async def test_backend_resume_overwrites_saved_request_with_current_model(
    tmp_path,
    monkeypatch,
) -> None:
    """恢复接口应把当前请求模型写回 SQLite，避免再次中断后退回旧模型。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()
    await initialize_database()
    checkpoint = await create_checkpoint(
        session_id="session-code",
        agent_kind="code",
        route="/api/chat",
        request={"selectedModel": "custom:old-model"},
        label="模型切换恢复",
    )
    body = ChatRequest(
        messages=[{"role": "user", "content": "继续任务"}],
        sessionId="session-code",
        projectId="project-1",
        selectedModel="custom:new-model",
        resumeCheckpointId=checkpoint.id,
    )
    await resolve_run_checkpoint(body)
    stored = await get_checkpoint(checkpoint.id)

    assert stored is not None
    # 后端应把当前模型写回请求快照，供再次中断后的下一次恢复使用。
    assert stored.request["selectedModel"] == "custom:new-model"
    get_settings.cache_clear()
