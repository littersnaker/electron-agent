"""Code Agent 循环状态的 JSON 序列化与恢复。"""

from __future__ import annotations

from typing import Any

from backend.services.agent.planner.task_planner import CodeTaskPlan, WorkItem, WorkLedger
from backend.services.agent.shared.command_runner import CommandResult
from backend.services.agent.shared.work_models import FileSystemOperation
from backend.services.llm.types import LlmUsage


def work_item_from_json(value: dict[str, Any]) -> WorkItem:
    """从稳定 JSON 恢复一个 Work。"""

    allowed_operation_types = {"rename", "move", "delete_empty_dir"}
    file_operations = [
        FileSystemOperation(
            type=str(item.get("type")),  # type: ignore[arg-type]
            source_path=str(item.get("sourcePath") or ""),
            target_path=str(item.get("targetPath") or ""),
        )
        for item in value.get("fileOperations", [])
        if isinstance(item, dict)
        and str(item.get("type") or "") in allowed_operation_types
        and str(item.get("sourcePath") or "")
    ]
    execution_type = str(value.get("executionType") or "agent").lower()
    allowed_execution_types = {"agent", "coding", "filesystem", "validation", "artifact"}
    if execution_type not in allowed_execution_types:
        execution_type = "agent"
    if execution_type == "filesystem" and not file_operations:
        execution_type = "agent"
    if execution_type != "filesystem":
        file_operations = []
    return WorkItem(
        id=str(value.get("id") or "W001"),
        title=str(value.get("title") or "恢复工作"),
        objective=str(value.get("objective") or "继续未完成任务"),
        acceptance_criteria=[
            str(item) for item in value.get("acceptanceCriteria", []) if str(item)
        ],
        dependencies=[str(item) for item in value.get("dependencies", []) if str(item)],
        priority=int(value.get("priority") or 100),
        target_files=[str(item) for item in value.get("targetFiles", []) if str(item)],
        serial_group=str(value.get("serialGroup") or ""),
        execution_type=execution_type,  # type: ignore[arg-type]
        file_operations=file_operations,
        validation_commands=[
            str(item) for item in value.get("validationCommands", []) if str(item)
        ],
        status=str(value.get("status") or "pending"),
        attempts=int(value.get("attempts") or 0),
        summary=str(value.get("summary") or ""),
        error=str(value.get("error") or ""),
        changed_files=[str(item) for item in value.get("changedFiles", []) if str(item)],
        commands=[str(item) for item in value.get("commands", []) if str(item)],
    )


def plan_to_json(plan: CodeTaskPlan) -> dict[str, Any]:
    """保存完整任务规格和初始 Work。"""

    return {
        "rawRequest": plan.raw_request,
        "optimizedPrompt": plan.optimized_prompt,
        "objective": plan.objective,
        "constraints": plan.constraints,
        "acceptanceCriteria": plan.acceptance_criteria,
        "nonGoals": plan.non_goals,
        "validationCommands": plan.validation_commands,
        "works": [item.to_json() for item in plan.works],
    }


def plan_from_json(value: dict[str, Any]) -> CodeTaskPlan:
    """从 Checkpoint 恢复任务规格。"""

    works = [
        work_item_from_json(item)
        for item in value.get("works", [])
        if isinstance(item, dict)
    ]
    if not works:
        works = [WorkItem("W001", "恢复任务", "继续上次未完成的代码任务")]
    return CodeTaskPlan(
        raw_request=str(value.get("rawRequest") or ""),
        optimized_prompt=str(value.get("optimizedPrompt") or value.get("rawRequest") or ""),
        objective=str(value.get("objective") or "继续上次未完成的代码任务"),
        constraints=[str(item) for item in value.get("constraints", [])],
        acceptance_criteria=[str(item) for item in value.get("acceptanceCriteria", [])],
        non_goals=[str(item) for item in value.get("nonGoals", [])],
        validation_commands=[str(item) for item in value.get("validationCommands", [])],
        works=works,
    )


def ledger_from_json(value: dict[str, Any]) -> WorkLedger:
    """恢复完整 WorkList，保留成功、失败、跳过和产物信息。"""

    items = [
        work_item_from_json(item)
        for item in value.get("items", [])
        if isinstance(item, dict)
    ]
    ledger = WorkLedger(items or [WorkItem("W001", "恢复任务", "继续任务")])
    ledger.revision = int(value.get("revision") or 1)
    ledger.reason = str(value.get("reason") or "已从 Checkpoint 恢复")
    return ledger


def command_to_json(result: CommandResult) -> dict[str, Any]:
    """序列化命令结果。"""

    return {
        "command": result.command,
        "exitCode": result.exit_code,
        "output": result.output,
        "timedOut": result.timed_out,
        "blockedReason": result.blocked_reason,
    }


def command_from_json(value: dict[str, Any]) -> CommandResult:
    """恢复命令结果。"""

    return CommandResult(
        command=str(value.get("command") or ""),
        exit_code=int(value.get("exitCode") or 0),
        output=str(value.get("output") or ""),
        timed_out=bool(value.get("timedOut")),
        blocked_reason=str(value.get("blockedReason") or ""),
    )


def usage_from_json(value: dict[str, Any]) -> LlmUsage:
    """恢复累计 Token 用量。"""

    return LlmUsage(
        prompt=int(value.get("prompt") or 0),
        completion=int(value.get("completion") or 0),
        total=int(value.get("total") or 0),
    )

async def save_loop_checkpoint(
    checkpoint_id: str,
    *,
    plan: CodeTaskPlan,
    ledger: WorkLedger,
    transcript: list[str],
    changed_files: list[str],
    commands: list[CommandResult],
    usage: LlmUsage,
    model_name: str,
    invalid_rounds: int,
    replan_round: int,
    next_iteration: int,
    execution_mode: str,
    worker_states: dict[str, dict[str, Any]] | None = None,
    active_work_ids: list[str] | None = None,
    project_harness: dict[str, Any] | None = None,
) -> None:
    """在每个安全动作后保存可精确继续的 Code Agent 状态。"""

    if not checkpoint_id:
        return
    from backend.services.checkpoints.store import update_checkpoint

    await update_checkpoint(
        checkpoint_id,
        status="running",
        resumable=True,
        state={
            "codeLoop": {
                "version": 2,
                "taskPlan": plan_to_json(plan),
                "ledger": ledger.snapshot(),
                "transcript": transcript,
                "changedFiles": changed_files,
                "commands": [command_to_json(item) for item in commands],
                "usage": {
                    "prompt": usage.prompt,
                    "completion": usage.completion,
                    "total": usage.total,
                },
                "modelName": model_name,
                "invalidRounds": invalid_rounds,
                "replanRound": replan_round,
                "nextIteration": next_iteration,
                "executionMode": execution_mode,
                "workerStates": worker_states or {},
                "activeWorkIds": active_work_ids or [],
                "projectHarness": project_harness or {},
            }
        },
    )


async def mark_checkpoint_paused(checkpoint_id: str) -> None:
    """把 Checkpoint 标记为暂停（等待用户审批），保持可恢复。"""

    if not checkpoint_id:
        return
    from backend.services.checkpoints.store import update_checkpoint

    await update_checkpoint(checkpoint_id, status="paused", resumable=True)
