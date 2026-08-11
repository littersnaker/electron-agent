"""Code Agent 循环的协议提示词与重规划辅助函数。"""

from __future__ import annotations

from typing import Literal

from backend.services.agent.command_runner import CommandResult
from backend.services.agent.task_planner import (
    CodeTaskPlan,
    ReplanResult,
    WorkItem,
    WorkLedger,
    replan_after_failure,
    replan_after_failures,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.types import LlmUsage

ExecutionMode = Literal["auto_edit", "full_auto"]

__all__ = [
    "ExecutionMode",
    "command_observation",
    "perform_batch_replan",
    "perform_replan",
    "usage_add",
]


def usage_add(total: LlmUsage, current: LlmUsage) -> None:
    """累加多轮模型调用 Token 用量。"""

    total.prompt += current.prompt
    total.completion += current.completion
    total.total += current.total


def command_observation(result: CommandResult) -> str:
    """把命令结果转换成下一轮模型可理解的观察。"""

    if result.blocked_reason:
        return f"RUN BLOCKED: {result.command}\n原因：{result.blocked_reason}"
    status = "TIMEOUT" if result.timed_out else f"EXIT {result.exit_code}"
    return f"RUN {status}: {result.command}\n{result.output or '（命令没有输出）'}"


def _fallback_replan(ledger: WorkLedger, failed_work_id: str, error: str) -> ReplanResult:
    """Planner 调用失败时仅重试失败 Work。"""

    current = ledger.get(failed_work_id)
    retry = WorkItem(
        id=failed_work_id,
        title=current.title if current else "重试失败工作",
        objective=current.objective if current else "根据真实错误继续修复",
        acceptance_criteria=current.acceptance_criteria if current else [],
        dependencies=current.dependencies if current else [],
        priority=current.priority if current else 100,
        target_files=current.target_files if current else [],
        serial_group=current.serial_group if current else "",
        execution_type=current.execution_type if current else "agent",
        file_operations=current.file_operations if current else [],
        validation_commands=current.validation_commands if current else [],
    )
    return ReplanResult(
        reason=f"Planner 暂时不可用，保留全部成功 Work，仅重试 {failed_work_id}：{error[:300]}",
        retry_items=[retry],
        new_items=[],
        skipped_ids=[],
        usage=LlmUsage(),
        model_name="",
    )


async def perform_replan(
    *,
    plan: CodeTaskPlan,
    ledger: WorkLedger,
    failed_work_id: str,
    failure_observation: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
) -> ReplanResult:
    """调用 Planner，并在失败时返回安全重试方案。"""

    try:
        return await replan_after_failure(
            plan=plan,
            ledger=ledger,
            failed_work_id=failed_work_id,
            failure_observation=failure_observation,
            preferred_model_id=preferred_model_id,
            credentials=credentials,
        )
    except Exception as exc:
        return _fallback_replan(ledger, failed_work_id, str(exc))


async def perform_batch_replan(
    *,
    plan: CodeTaskPlan,
    ledger: WorkLedger,
    failed_work_ids: list[str],
    failure_observation: str,
    failures: list[dict[str, object]] | None = None,
    preferred_model_id: str,
    credentials: LlmCredentials,
) -> ReplanResult:
    """一次重规划整个并行波次，避免成功 Work 被重复创建或执行。"""

    try:
        return await replan_after_failures(
            plan=plan,
            ledger=ledger,
            failed_work_ids=failed_work_ids,
            failure_observation=failure_observation,
            failures=failures,
            preferred_model_id=preferred_model_id,
            credentials=credentials,
        )
    except Exception as exc:
        retry_items: list[WorkItem] = []
        for work_id in failed_work_ids:
            current = ledger.get(work_id)
            if current:
                retry_items.append(
                    WorkItem(
                        id=current.id,
                        title=current.title,
                        objective=current.objective,
                        acceptance_criteria=current.acceptance_criteria,
                        dependencies=current.dependencies,
                        priority=current.priority,
                        target_files=current.target_files,
                        serial_group=current.serial_group,
                        execution_type=current.execution_type,
                        file_operations=current.file_operations,
                        validation_commands=current.validation_commands,
                    )
                )
        return ReplanResult(
            reason=(
                "Planner 暂时不可用，已保留全部成功 Work，仅重试本波次失败项："
                f"{str(exc)[:300]}"
            ),
            retry_items=retry_items,
            new_items=[],
            skipped_ids=[],
            usage=LlmUsage(),
            model_name="",
        )
