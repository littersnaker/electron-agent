"""Code Agent 滚动调度循环的状态合并与安全阈值工具。"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from time import monotonic
from typing import Awaitable, Callable

from backend.services.agent.command_runner import CommandResult
from backend.services.agent.work_models import WorkLedger
from backend.services.agent.work_state import WorkExecutionResult, WorkWorkerState

CheckpointWriter = Callable[[], Awaitable[None]]


@dataclass(slots=True)
class ResultMerge:
    """保存一个 Worker 终态合并后的生命周期信息。"""

    lifecycle: dict[str, object]
    failed_id: str = ""
    failure_observation: str = ""
    failure_kind: str = ""


class CheckpointThrottle:
    """合并短时间内重复的全量 Checkpoint 写入。"""

    def __init__(self, interval_seconds: float = 30.0) -> None:
        """初始化串行锁和最小写入间隔。"""

        self._interval_seconds = max(0.0, interval_seconds)
        self._last_saved_at = 0.0
        self._lock = asyncio.Lock()

    async def save(self, writer: CheckpointWriter, *, force: bool = False) -> None:
        """在需要时执行一次写入；强制写入用于 Work 启停和最终状态。"""

        async with self._lock:
            now = monotonic()
            if not force and now - self._last_saved_at < self._interval_seconds:
                return
            await writer()
            self._last_saved_at = monotonic()


def load_worker_states(
    resume_state: dict[str, object] | None,
) -> dict[str, WorkWorkerState]:
    """从 Checkpoint 恢复每个并行 Worker 的独立状态。"""

    if not resume_state:
        return {}
    raw = resume_state.get("workerStates")
    if not isinstance(raw, dict):
        return {}
    return {
        str(work_id): WorkWorkerState.from_json(value)
        for work_id, value in raw.items()
        if isinstance(value, dict)
    }


def unique_extend(target: list[str], values: list[str]) -> None:
    """保持首次出现顺序合并字符串列表。"""

    for value in values:
        if value not in target:
            target.append(value)


def merge_worker_result(
    *,
    ledger: WorkLedger,
    result: WorkExecutionResult,
    changed_files: list[str],
    command_results: list[CommandResult],
    replan_round: int,
) -> ResultMerge:
    """把单个 Worker 结果立即写入 Ledger，并生成前端生命周期事件。"""

    state = result.state
    unique_extend(changed_files, state.changed_files)
    for command in state.commands:
        if command not in command_results:
            command_results.append(command)
    ledger.add_artifacts(result.work_id, state.changed_files)
    for command in state.commands:
        ledger.add_command(result.work_id, command.command)

    if result.succeeded:
        ledger.succeed(result.work_id, result.summary)
        return ResultMerge(
            lifecycle={
                "role": "reviewer_agent",
                "agentId": f"reviewer_agent:{result.work_id}",
                "status": "completed",
                "detail": f"{result.work_id} 已验收完成",
                "iteration": replan_round,
            }
        )

    ledger.fail(result.work_id, result.error)
    summary_data = state.failure_summary or {"error": result.error[:4_000]}
    return ResultMerge(
        lifecycle={
            "role": "modify_worker",
            "agentId": f"modify_worker:{result.work_id}",
            "status": "failed",
            "detail": (
                f"{result.work_id} 运行时失败，准备干净重试："
                f"{str(result.error)[:120]}"
                if result.failure_kind == "runtime"
                else f"{result.work_id} 执行失败，等待统一重规划："
                f"{str(result.error)[:120]}"
            ),
            "iteration": replan_round,
        },
        failed_id=result.work_id,
        failure_observation=(
            f"{result.work_id} [{result.failure_kind}]: {summary_data}"
        ),
        failure_kind=result.failure_kind,
    )


def max_replan_rounds() -> int:
    """读取全任务最大重规划轮数，防止返工无限增长。"""

    return _env_int("CODE_AGENT_MAX_REPLANS", 3, 0, 10)


def max_work_attempts() -> int:
    """读取单个 Work 的最大尝试次数。"""

    return _env_int("CODE_AGENT_MAX_WORK_ATTEMPTS", 3, 1, 10)



def max_runtime_attempts() -> int:
    """读取运行时错误的最大干净重试次数，避免协议错误进入代码重规划。"""

    return _env_int("CODE_AGENT_MAX_RUNTIME_ATTEMPTS", 2, 1, 5)


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """读取整数环境变量并限制在安全区间。"""

    try:
        value = int(os.getenv(name, str(default)).strip())
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


__all__ = [
    "CheckpointThrottle",
    "ResultMerge",
    "load_worker_states",
    "max_replan_rounds",
    "max_runtime_attempts",
    "max_work_attempts",
    "merge_worker_result",
    "unique_extend",
]
