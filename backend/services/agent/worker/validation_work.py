"""Validation Work 的确定性执行入口。"""

from __future__ import annotations

from pathlib import Path

from backend.services.agent.shared.command_runner import run_safe_command
from backend.services.agent.shared.loop_support import ExecutionMode
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import (
    CheckpointCallback,
    EmitCallback,
    WorkExecutionResult,
    WorkWorkerState,
)
from backend.services.quality.validation_engine import ValidationEngine


async def execute_validation_work(
    *,
    root: Path,
    work: WorkItem,
    commands: list[str] | None = None,
    state: WorkWorkerState,
    execution_mode: ExecutionMode,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
) -> WorkExecutionResult:
    """直接执行验证命令，避免单纯测试 Work 继续消耗模型 Token。"""

    await emit(
        "lifecycle",
        {
            "role": "verification_agent",
            "agentId": f"validation_worker:{work.id}",
            "slot": slot,
            "status": "running",
            "detail": f"{work.id} · {work.title}：执行确定性验证",
            "toolName": "validation_engine",
        },
    )
    commands = list(dict.fromkeys(commands or work.validation_commands))
    if not commands:
        plan = ValidationEngine().plan(
            root=root,
            changed_files=work.target_files,
            risk="medium",
        )
        commands = [check.command for check in plan.checks]
    if execution_mode != "full_auto":
        state.quality["validation"] = {
            "executed": False,
            "passed": False,
            "commands": commands,
            "reason": "自动编辑模式不执行终端命令",
        }
        await checkpoint()
        return WorkExecutionResult(
            work_id=work.id,
            succeeded=True,
            summary="已生成验证计划；自动编辑模式未执行终端命令。",
            error="",
            state=state,
        )

    for command in commands:
        result = await run_safe_command(root, command)
        state.commands.append(result)
        state.append_transcript(
            f"VALIDATION {command}: {'passed' if result.succeeded else 'failed'}\n"
            f"{result.output[-4_000:]}"
        )
        await checkpoint()
        if not result.succeeded:
            return WorkExecutionResult(
                work_id=work.id,
                succeeded=False,
                summary="",
                error=f"VALIDATION FAILED: {command}\n{result.output[-4_000:]}",
                state=state,
            )
    state.quality["validation"] = {
        "executed": bool(commands),
        "passed": True,
        "commands": commands,
    }
    await checkpoint()
    await emit(
        "lifecycle",
        {
            "role": "verification_agent",
            "agentId": f"validation_worker:{work.id}",
            "slot": slot,
            "status": "completed",
            "detail": f"{work.id} 的 {len(commands)} 项验证均已通过",
        },
    )
    return WorkExecutionResult(
        work_id=work.id,
        succeeded=True,
        summary=f"已通过 {len(commands)} 项确定性验证。",
        error="",
        state=state,
    )


__all__ = ["execute_validation_work"]
