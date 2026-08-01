"""Code Agent 依赖图并行调度循环。"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

from backend.services.agent.checkpoint_runtime import (
    command_from_json,
    ledger_from_json,
    save_loop_checkpoint,
    usage_from_json,
)
from backend.services.agent.command_runner import CommandResult
from backend.services.agent.fast_work import execute_fast_filesystem_work
from backend.services.agent.loop_support import ExecutionMode, perform_batch_replan, usage_add
from backend.services.agent.resource_coordinator import (
    WorkspaceResourceCoordinator,
    max_parallel_workers,
    select_parallel_wave,
)
from backend.services.agent.task_planner import CodeTaskPlan, WorkLedger
from backend.services.agent.work_worker import (
    WorkExecutionResult,
    WorkWorkerState,
    execute_work,
)
from backend.services.agent.workspace_tools import render_workspace_tree
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY  # 保留测试与插件的共享网关补丁入口。
from backend.services.llm.types import LlmUsage


@dataclass(slots=True)
class AgentLoopResult:
    """并行代理任务的最终真实结果。"""

    summary: str
    changed_files: list[str]
    commands: list[CommandResult]
    usage: LlmUsage
    model_name: str
    iterations: int
    replans: int
    optimized_prompt: str
    objective: str
    worklist: dict[str, Any]


@dataclass(slots=True)
class AgentLoopEvent:
    """代理循环向 SSE 编排层发送的内部事件。"""

    kind: Literal["lifecycle", "tool", "usage", "worklist", "result"]
    payload: dict[str, Any] = field(default_factory=dict)
    result: AgentLoopResult | None = None


def _unique_extend(target: list[str], values: list[str]) -> None:
    """保持首次出现顺序合并字符串列表。"""

    for value in values:
        if value not in target:
            target.append(value)


def _scheduler_snapshot(
    ledger: WorkLedger,
    *,
    active_work_ids: list[str],
    parallel_limit: int,
) -> dict[str, Any]:
    """在完整 WorkList 上附加并行调度状态，供前端准确展示。"""

    snapshot = ledger.snapshot()
    snapshot["scheduler"] = {
        "mode": "dependency_graph",
        "maxParallel": parallel_limit,
        "activeWorkIds": active_work_ids,
    }
    return snapshot


def _load_worker_states(resume_state: dict[str, Any] | None) -> dict[str, WorkWorkerState]:
    """恢复每个并行 Worker 的独立工具上下文。"""

    if not resume_state:
        return {}
    raw = dict(resume_state.get("workerStates") or {})
    return {
        str(work_id): WorkWorkerState.from_json(value)
        for work_id, value in raw.items()
        if isinstance(value, dict)
    }


async def stream_autonomous_loop(
    *,
    root: Path,
    task_plan: CodeTaskPlan,
    initial_context: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
    execution_mode: ExecutionMode,
    initial_usage: LlmUsage | None = None,
    initial_model_name: str = "",
    checkpoint_id: str = "",
    resume_state: dict[str, Any] | None = None,
):
    """按依赖、优先级和文件冲突并行执行 Work，并在波次结束后统一重规划。"""

    if resume_state:
        ledger = ledger_from_json(dict(resume_state.get("ledger") or {}))
        ledger.reset_interrupted_running()
        transcript = [str(item) for item in resume_state.get("transcript", [])]
        changed_files = [str(item) for item in resume_state.get("changedFiles", [])]
        command_results = [
            command_from_json(item)
            for item in resume_state.get("commands", [])
            if isinstance(item, dict)
        ]
        total_usage = usage_from_json(dict(resume_state.get("usage") or {}))
        model_name = str(resume_state.get("modelName") or initial_model_name)
        replan_round = int(resume_state.get("replanRound") or 0)
        base_iterations = int(resume_state.get("nextIteration") or 0)
        worker_states = _load_worker_states(resume_state)
        transcript.append("CHECKPOINT RESTORED: 只继续未完成 Work。")
    else:
        ledger = WorkLedger(task_plan.works)
        transcript = [f"TASK SPEC:\n{task_plan.to_prompt_json()}"]
        changed_files = []
        command_results = []
        total_usage = initial_usage or LlmUsage()
        model_name = initial_model_name
        replan_round = 0
        base_iterations = 0
        worker_states: dict[str, WorkWorkerState] = {}

    project_tree = render_workspace_tree(root)
    coordinator = WorkspaceResourceCoordinator()
    parallel_limit = max_parallel_workers()
    checkpoint_lock = asyncio.Lock()
    usage_lock = asyncio.Lock()
    active_work_ids: list[str] = []

    async def persist_checkpoint() -> None:
        """串行写入包含全部并行分支的安全 Checkpoint。"""

        async with checkpoint_lock:
            await save_loop_checkpoint(
                checkpoint_id,
                plan=task_plan,
                ledger=ledger,
                transcript=transcript,
                changed_files=changed_files,
                commands=command_results,
                usage=total_usage,
                model_name=model_name,
                invalid_rounds=0,
                replan_round=replan_round,
                next_iteration=base_iterations
                + sum(state.iterations for state in worker_states.values()),
                execution_mode=execution_mode,
                worker_states={
                    work_id: state.to_json()
                    for work_id, state in worker_states.items()
                },
                active_work_ids=list(active_work_ids),
            )

    yield AgentLoopEvent(
        "worklist",
        _scheduler_snapshot(
            ledger,
            active_work_ids=active_work_ids,
            parallel_limit=parallel_limit,
        ),
    )

    while not ledger.all_finished():
        ready = ledger.ready_items()
        if not ready:
            failed = [item for item in ledger.items if item.status == "failed"]
            blocked = [
                item
                for item in ledger.items
                if item.status not in {"succeeded", "skipped"}
            ]
            if not failed:
                details = ", ".join(
                    f"{item.id}(依赖:{item.dependencies})" for item in blocked
                )
                raise ValueError(f"WorkList 存在循环依赖或不可满足依赖：{details}")
            ready = failed

        wave = select_parallel_wave(ready, parallel_limit)
        active_work_ids = [item.id for item in wave]
        for work in wave:
            ledger.begin(work.id)
            worker_states.setdefault(work.id, WorkWorkerState())
        ledger.reason = (
            f"并行执行 {len(wave)} 个 Work：{', '.join(active_work_ids)}"
            if len(wave) > 1
            else f"执行 {active_work_ids[0]}"
        )
        await persist_checkpoint()
        yield AgentLoopEvent(
            "worklist",
            _scheduler_snapshot(
                ledger,
                active_work_ids=active_work_ids,
                parallel_limit=parallel_limit,
            ),
        )

        event_queue: asyncio.Queue[AgentLoopEvent] = asyncio.Queue()

        async def emit(kind: str, payload: dict[str, Any]) -> None:
            """让并行 Worker 汇入 SSE，并在落 Checkpoint 前累计 Token。"""

            if kind == "usage":
                current = LlmUsage(
                    prompt=int(payload.get("prompt") or 0),
                    completion=int(payload.get("completion") or 0),
                    total=int(payload.get("total") or 0),
                )
                async with usage_lock:
                    usage_add(total_usage, current)
                    payload = {
                        "prompt": total_usage.prompt,
                        "completion": total_usage.completion,
                        "total": total_usage.total,
                    }
            await event_queue.put(AgentLoopEvent(kind, payload))  # type: ignore[arg-type]

        async def run_one(work_id: str, slot: int) -> WorkExecutionResult:
            """执行一个 Worker，并把意外异常转换成可重规划失败。"""

            work = ledger.get(work_id)
            if not work:
                raise ValueError(f"未知 Work：{work_id}")
            try:
                if work.execution_type == "filesystem" and work.file_operations:
                    return await execute_fast_filesystem_work(
                        root=root,
                        work=work,
                        coordinator=coordinator,
                        state=worker_states[work_id],
                        emit=emit,
                        checkpoint=persist_checkpoint,
                        slot=slot,
                    )
                return await execute_work(
                    root=root,
                    task_plan=task_plan,
                    work=work,
                    initial_context=initial_context,
                    project_tree=project_tree,
                    ledger_snapshot=ledger.snapshot(),
                    preferred_model_id=preferred_model_id,
                    credentials=credentials,
                    execution_mode=execution_mode,
                    coordinator=coordinator,
                    state=worker_states[work_id],
                    emit=emit,
                    checkpoint=persist_checkpoint,
                    slot=slot,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                return WorkExecutionResult(
                    work_id=work_id,
                    succeeded=False,
                    summary="",
                    error=f"WORKER CRASHED: {exc}",
                    state=worker_states[work_id],
                )

        tasks = [
            asyncio.create_task(run_one(work.id, slot))
            for slot, work in enumerate(wave, start=1)
        ]
        gathered = asyncio.gather(*tasks)
        try:
            while not gathered.done() or not event_queue.empty():
                try:
                    event = await asyncio.wait_for(event_queue.get(), timeout=0.08)
                except TimeoutError:
                    continue
                yield event

            results = await gathered
            while not event_queue.empty():
                yield event_queue.get_nowait()
        finally:
            # 用户点击“停止”或客户端断开时，不能让并行 Worker 在后台继续改文件。
            if not gathered.done():
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)

        failure_observations: list[str] = []
        failed_ids: list[str] = []
        for result in results:
            state = result.state
            model_name = state.model_name or model_name
            _unique_extend(changed_files, state.changed_files)
            for command in state.commands:
                if command not in command_results:
                    command_results.append(command)
            ledger.add_artifacts(result.work_id, state.changed_files)
            for command in state.commands:
                ledger.add_command(result.work_id, command.command)
            if result.succeeded:
                ledger.succeed(result.work_id, result.summary)
                yield AgentLoopEvent(
                    "lifecycle",
                    {
                        "role": "reviewer_agent",
                        "agentId": f"reviewer_agent:{result.work_id}",
                        "status": "completed",
                        "detail": f"{result.work_id} 已验收完成",
                        "iteration": replan_round,
                    },
                )
            else:
                ledger.fail(result.work_id, result.error)
                failed_ids.append(result.work_id)
                failure_observations.append(f"{result.work_id}: {result.error}")
                yield AgentLoopEvent(
                    "lifecycle",
                    {
                        "role": "modify_worker",
                        "agentId": f"modify_worker:{result.work_id}",
                        "status": "failed",
                        "detail": f"{result.work_id} 执行失败，等待波次统一重规划",
                        "iteration": replan_round,
                    },
                )

        active_work_ids = []
        await persist_checkpoint()
        yield AgentLoopEvent(
            "worklist",
            _scheduler_snapshot(
                ledger,
                active_work_ids=active_work_ids,
                parallel_limit=parallel_limit,
            ),
        )

        if failed_ids:
            replan_round += 1
            yield AgentLoopEvent(
                "lifecycle",
                {
                    "role": "task_planner",
                    "agentId": f"task_planner:replan:{replan_round}",
                    "status": "running",
                    "detail": (
                        "正在把本波次全部成功、失败、待办 Work JSON 交给 Planner…"
                    ),
                    "iteration": replan_round,
                },
            )
            replan = await perform_batch_replan(
                plan=task_plan,
                ledger=ledger,
                failed_work_ids=failed_ids,
                failure_observation="\n\n".join(failure_observations),
                preferred_model_id=preferred_model_id,
                credentials=credentials,
            )
            usage_add(total_usage, replan.usage)
            ledger.apply_replan(replan)
            transcript.append(
                f"BATCH REPLAN {replan_round}: {replan.reason}\n"
                f"FAILED: {failed_ids}\nSNAPSHOT: {ledger.snapshot()}"
            )
            for work_id in failed_ids:
                state = worker_states.setdefault(work_id, WorkWorkerState())
                state.transcript.append(
                    f"PLANNER REPLAN: {replan.reason}\n请按新的 Work 定义继续，已成功产物不得重做。"
                )
            await persist_checkpoint()
            yield AgentLoopEvent(
                "worklist",
                _scheduler_snapshot(
                    ledger,
                    active_work_ids=[],
                    parallel_limit=parallel_limit,
                ),
            )
            yield AgentLoopEvent(
                "lifecycle",
                {
                    "role": "task_planner",
                    "agentId": f"task_planner:replan:{replan_round}",
                    "status": "completed",
                    "detail": replan.reason,
                    "iteration": replan_round,
                },
            )

    await persist_checkpoint()
    yield AgentLoopEvent(
        "lifecycle",
        {
            "role": "reviewer_agent",
            "agentId": "reviewer_agent:final",
            "status": "completed",
            "detail": "已核对依赖图：所有 Work 均成功或明确跳过。",
            "iteration": replan_round,
        },
    )
    succeeded = sum(item.status == "succeeded" for item in ledger.items)
    skipped = sum(item.status == "skipped" for item in ledger.items)
    summary = f"已完成 {succeeded} 个 Work，跳过 {skipped} 个无需执行 Work。"
    # 最终摘要直接由真实 WorkList、文件和命令结果生成。
    # 这里不再额外调用大模型，避免纯文件操作完成后仍消耗额度或因额度耗尽失败。
    yield AgentLoopEvent(
        "usage",
        {
            "prompt": total_usage.prompt,
            "completion": total_usage.completion,
            "total": total_usage.total,
        },
    )
    result = AgentLoopResult(
        summary=summary,
        changed_files=changed_files,
        commands=command_results,
        usage=total_usage,
        model_name=model_name,
        # 最终汇总视为一个编排轮次，保持旧版统计语义并区分工具轮次。
        iterations=base_iterations
        + sum(state.iterations for state in worker_states.values())
        + 1,
        replans=replan_round,
        optimized_prompt=task_plan.optimized_prompt,
        objective=task_plan.objective,
        worklist=_scheduler_snapshot(
            ledger,
            active_work_ids=[],
            parallel_limit=parallel_limit,
        ),
    )
    yield AgentLoopEvent("result", result=result)
