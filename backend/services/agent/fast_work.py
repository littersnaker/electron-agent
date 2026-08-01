"""确定性文件操作 Work 的无模型快速执行入口。"""

from __future__ import annotations

import asyncio
from pathlib import Path

from backend.services.agent.filesystem_executor import (
    execute_filesystem_operations,
    operation_resources,
)
from backend.services.agent.resource_coordinator import WorkspaceResourceCoordinator
from backend.services.agent.work_models import WorkItem
from backend.services.agent.work_worker import (
    CheckpointCallback,
    EmitCallback,
    WorkExecutionResult,
    WorkWorkerState,
)


async def execute_fast_filesystem_work(
    *,
    root: Path,
    work: WorkItem,
    coordinator: WorkspaceResourceCoordinator,
    state: WorkWorkerState,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
) -> WorkExecutionResult:
    """直接执行 Planner 给出的确定性文件操作，完全跳过 Worker LLM。"""

    resources = operation_resources(work.file_operations)
    agent_id = f"filesystem_worker:{work.id}"
    await emit(
        "lifecycle",
        {
            "role": "modify_worker",
            "agentId": agent_id,
            "slot": slot,
            "status": "running",
            "detail": f"{work.id} · {work.title}：本地快速执行文件操作",
            "toolName": "filesystem_fast_path",
        },
    )
    await emit(
        "tool",
        {
            "workId": work.id,
            "label": f"{work.id} 正在本地执行重命名/移动，不调用大模型",
        },
    )
    try:
        async with coordinator.reserve(
            resources,
            owner=work.id,
            priority=work.priority,
        ):
            result = await asyncio.to_thread(
                execute_filesystem_operations,
                root,
                work.file_operations,
            )
    except Exception as exc:
        state.transcript.append(f"FILESYSTEM FAST PATH FAILED: {exc}")
        await checkpoint()
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=False,
            summary="",
            error=f"FILESYSTEM OPERATION FAILED: {exc}",
            state=state,
        )

    for path in result.changed_paths:
        if path not in state.changed_files:
            state.changed_files.append(path)
    state.transcript.append(
        "FILESYSTEM FAST PATH COMPLETED\n"
        f"OPERATIONS: {[item.to_json() for item in work.file_operations]}\n"
        f"CHANGED: {result.changed_paths}"
    )
    await checkpoint()
    await emit(
        "lifecycle",
        {
            "role": "merge_agent",
            "agentId": f"merge_agent:{work.id}",
            "slot": slot,
            "status": "completed",
            "detail": f"{work.id} 已由本地执行器完成，无模型调用",
            "toolName": "filesystem_fast_path",
        },
    )
    return WorkExecutionResult(
        work_id=work.id,
        succeeded=True,
        summary=result.summary,
        error="",
        state=state,
    )
