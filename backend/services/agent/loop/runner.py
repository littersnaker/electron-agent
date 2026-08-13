"""Code Agent 依赖图滚动并行调度循环。"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any, Literal

from backend.services.agent.harness import ProjectHarness, build_project_harness
from backend.services.agent.loop.checkpoint_runtime import (
    command_from_json,
    ledger_from_json,
    save_loop_checkpoint,
    usage_from_json,
)
from backend.services.agent.loop.final_quality import review_execution
from backend.services.agent.loop.loop_runtime import (
    CheckpointThrottle,
    load_worker_states,
    max_replan_rounds,
    max_runtime_attempts,
    max_work_attempts,
    merge_worker_result,
)
from backend.services.agent.loop.loop_snapshot import build_scheduler_snapshot
from backend.services.agent.planner.target_preflight import preflight_plan_works
from backend.services.agent.planner.task_planner import CodeTaskPlan, WorkLedger
from backend.services.agent.reflection.runner import schedule_work_review
from backend.services.agent.shared.command_runner import CommandResult
from backend.services.agent.shared.loop_support import (
    ExecutionMode,
    perform_batch_replan,
    usage_add,
)
from backend.services.agent.shared.resource_coordinator import (
    WorkspaceResourceCoordinator,
    max_parallel_workers,
    select_parallel_candidates,
)
from backend.services.agent.shared.work_state import WorkExecutionResult, WorkWorkerState
from backend.services.agent.shared.workspace_tools import render_workspace_tree
from backend.services.agent.worker.work_dispatcher import (
    WorkDispatchEnvironment,
    WorkDispatcher,
)
from backend.services.agent.worker.worklist_normalizer import split_works_by_size
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY  # noqa: F401 - 测试通过共享网关打补丁。
from backend.services.llm.types import LlmUsage
from backend.services.workspace.completed_works import skip_redundant_works


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
    quality: dict[str, Any]


@dataclass(slots=True)
class AgentLoopEvent:
    """代理循环向 SSE 编排层发送的内部事件。"""

    kind: Literal["lifecycle", "tool", "usage", "worklist", "result"]
    payload: dict[str, Any] = field(default_factory=dict)
    result: AgentLoopResult | None = None


async def stream_autonomous_loop(
    *,
    root: Path,
    task_plan: CodeTaskPlan,
    project_id: str = "",
    initial_context: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
    execution_mode: ExecutionMode,
    initial_usage: LlmUsage | None = None,
    initial_model_name: str = "",
    checkpoint_id: str = "",
    resume_state: dict[str, Any] | None = None,
):
    """滚动执行依赖图；任一 Work 完成后立即补充新任务，不等待整波结束。"""

    project_tree = await asyncio.to_thread(render_workspace_tree, root, limit=800)
    preflight_notes: list[str] = []
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
        worker_states = load_worker_states(resume_state)
        transcript.append("CHECKPOINT RESTORED: 只继续未完成 Work。")
    else:
        preflight_notes = preflight_plan_works(task_plan.works, project_tree)
        preflight_notes.extend(split_works_by_size(task_plan.works, root))
        ledger = WorkLedger(task_plan.works)
        transcript = [f"TASK SPEC:\n{task_plan.to_prompt_json()}"]
        changed_files: list[str] = []
        command_results: list[CommandResult] = []
        total_usage = initial_usage or LlmUsage()
        model_name = initial_model_name
        replan_round = 0
        base_iterations = 0
        worker_states: dict[str, WorkWorkerState] = {}
        if project_id.strip():
            await skip_redundant_works(
                root=root,
                project_id=project_id,
                ledger=ledger,
            )

    restored_harness = (
        dict(resume_state.get("projectHarness") or {}) if resume_state else {}
    )
    harness = (
        ProjectHarness.from_json(restored_harness)
        if restored_harness
        else build_project_harness(
            root=root,
            request_text=task_plan.raw_request,
            runtime_context=initial_context,
        )
    )
    coordinator = WorkspaceResourceCoordinator()
    parallel_limit = max_parallel_workers()
    checkpoint_throttle = CheckpointThrottle()
    usage_lock = asyncio.Lock()
    event_queue: asyncio.Queue[AgentLoopEvent] = asyncio.Queue()
    active_work_ids: list[str] = []

    def snapshot(*, quality: dict[str, Any] | None = None) -> dict[str, Any]:
        """生成当前滚动任务池和质量指标的统一快照。"""

        return build_scheduler_snapshot(
            ledger,
            active_work_ids=active_work_ids,
            parallel_limit=parallel_limit,
            worker_states=worker_states,
            usage=total_usage,
            retry_count=replan_round,
            quality=quality,
        )

    async def persist_checkpoint(*, force: bool = False) -> None:
        """节流保存全部并行分支；Work 启停和最终状态使用强制写入。"""

        async def writer() -> None:
            """把当前内存状态序列化到现有 Checkpoint 仓储。"""

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
                project_harness=harness.to_json(),
            )

        await checkpoint_throttle.save(writer, force=force)

    async def emit(kind: str, payload: dict[str, Any]) -> None:
        """汇总并行 Worker 事件，并把单次 Token 转换为任务累计值。"""

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

    dispatcher = WorkDispatcher(
        WorkDispatchEnvironment(
            root=root,
            task_plan=task_plan,
            harness=harness,
            initial_context=initial_context,
            project_tree=project_tree,
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            execution_mode=execution_mode,
            coordinator=coordinator,
            emit=emit,
            checkpoint=persist_checkpoint,
        )
    )

    async def run_one(work_id: str, slot: int) -> WorkExecutionResult:
        """执行一个路由后的 Work，并把崩溃转换成可诊断失败。"""

        work = ledger.get(work_id)
        if not work:
            raise ValueError(f"未知 Work：{work_id}")
        try:
            # 每个 Worker 使用独立的 WorkItem 副本，避免并行执行时共享字段互相污染。
            isolated_work = replace(work)
            return await dispatcher.execute(
                work=isolated_work,
                state=worker_states[work_id],
                slot=slot,
                ledger_snapshot=ledger.snapshot(),
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
                failure_kind="runtime",
            )

    running: dict[asyncio.Task[WorkExecutionResult], tuple[str, int]] = {}
    failure_observations: dict[str, str] = {}
    failure_kinds: dict[str, str] = {}

    if preflight_notes:
        event_queue.put_nowait(
            AgentLoopEvent(
                "lifecycle",
                {
                    "role": "task_planner",
                    "agentId": "task_planner",
                    "status": "completed",
                    "detail": "；".join(preflight_notes),
                    "iteration": 0,
                },
            )
        )
    yield AgentLoopEvent("worklist", snapshot())
    try:
        while not ledger.all_finished():
            used_slots = {slot for _work_id, slot in running.values()}
            free_slots = [
                slot for slot in range(1, parallel_limit + 1) if slot not in used_slots
            ]
            ready = [item for item in ledger.ready_items() if item.status == "pending"]
            active_items = [
                item
                for work_id, _slot in running.values()
                if (item := ledger.get(work_id)) is not None
            ]
            selected = select_parallel_candidates(
                ready,
                active_items,
                len(free_slots),
            )
            for work, slot in zip(selected, free_slots, strict=False):
                ledger.begin(work.id)
                state = worker_states.setdefault(work.id, WorkWorkerState())
                state.begin_attempt(work.attempts)
                task = asyncio.create_task(run_one(work.id, slot))
                running[task] = (work.id, slot)

            if selected:
                active_work_ids = [
                    work_id
                    for work_id, _slot in sorted(running.values(), key=lambda item: item[1])
                ]
                ledger.reason = (
                    f"滚动并行执行 {len(running)} 个 Work："
                    f"{', '.join(active_work_ids)}"
                )
                await persist_checkpoint(force=True)
                yield AgentLoopEvent("worklist", snapshot())

            while not event_queue.empty():
                yield event_queue.get_nowait()

            if running:
                done, _pending = await asyncio.wait(
                    set(running),
                    timeout=0.08,
                    return_when=asyncio.FIRST_COMPLETED,
                )
                while not event_queue.empty():
                    yield event_queue.get_nowait()
                if not done:
                    continue

                ordered_done = sorted(done, key=lambda task: running[task][1])
                for task in ordered_done:
                    work_id, _slot = running.pop(task)
                    result = task.result()
                    schedule_work_review(
                        work_id=work_id,
                        succeeded=result.succeeded,
                        complexity=getattr(result.state, "iterations", 0),
                        summary=result.summary,
                        error=result.error,
                        failure_kind=getattr(result, "failure_kind", None) or "",
                        changed_files=list(result.state.changed_files),
                        transcript_tail=list(result.state.transcript),
                        project_id=project_id,
                        credentials=credentials,
                    )
                    if result.state.model_name:
                        model_name = result.state.model_name
                    merged = merge_worker_result(
                        ledger=ledger,
                        result=result,
                        changed_files=changed_files,
                        command_results=command_results,
                        replan_round=replan_round,
                    )
                    if merged.failed_id:
                        failure_observations[merged.failed_id] = merged.failure_observation
                        failure_kinds[merged.failed_id] = merged.failure_kind or "code"
                    else:
                        failure_observations.pop(work_id, None)
                        failure_kinds.pop(work_id, None)
                    yield AgentLoopEvent(
                        "lifecycle",
                        dict(merged.lifecycle),
                    )

                active_work_ids = [
                    work_id
                    for work_id, _slot in sorted(running.values(), key=lambda item: item[1])
                ]
                await persist_checkpoint(force=True)
                yield AgentLoopEvent("worklist", snapshot())
                continue

            failed = [item for item in ledger.items if item.status == "failed"]
            if failed:
                runtime_failed = [
                    item
                    for item in failed
                    if failure_kinds.get(item.id) == "runtime"
                ]
                if runtime_failed:
                    exhausted_runtime = [
                        item
                        for item in runtime_failed
                        if item.attempts >= max_runtime_attempts()
                    ]
                    if exhausted_runtime:
                        details = ", ".join(
                            f"{item.id}({item.attempts} 次)"
                            for item in exhausted_runtime
                        )
                        # 附上最近一次真实原因（如未配置 API Key），避免 UI
                        # 只看到笼统的"连续错误"而无法定位配置问题。
                        reasons = []
                        for item in exhausted_runtime:
                            reason = failure_observations.get(
                                item.id, item.error or ""
                            )
                            reason = " ".join(str(reason).split())[:200]
                            if reason:
                                reasons.append(f"{item.id}：{reason}")
                        suffix = f"；最近原因：{'；'.join(reasons)}" if reasons else ""
                        raise ValueError(
                            "以下 Work 连续发生模型协议、超时或守卫错误，"
                            f"已停止创建无关代码返工项：{details}{suffix}"
                        )
                    for item in runtime_failed:
                        ledger.retry_runtime_failure(
                            item.id,
                            failure_observations.get(item.id, item.error),
                        )
                        failure_kinds.pop(item.id, None)
                        failure_observations.pop(item.id, None)
                    await persist_checkpoint(force=True)
                    yield AgentLoopEvent("worklist", snapshot())
                    continue

                exhausted = [
                    item for item in failed if item.attempts >= max_work_attempts()
                ]
                if exhausted:
                    details = ", ".join(
                        f"{item.id}({item.attempts} 次)" for item in exhausted
                    )
                    raise ValueError(
                        f"以下 Work 已达到最大尝试次数，停止继续返工：{details}"
                    )
                if replan_round >= max_replan_rounds():
                    raise ValueError(
                        f"任务已达到 {max_replan_rounds()} 轮重规划上限，"
                        "已停止无限返工。"
                    )

                failed_ids = [item.id for item in failed]
                replan_round += 1
                yield AgentLoopEvent(
                    "lifecycle",
                    {
                        "role": "task_planner",
                        "agentId": f"task_planner:replan:{replan_round}",
                        "status": "running",
                        "detail": "正在根据失败摘要调整未完成 Work…",
                        "iteration": replan_round,
                    },
                )
                replan = await perform_batch_replan(
                    plan=task_plan,
                    ledger=ledger,
                    failed_work_ids=failed_ids,
                    failures=[
                        {
                            "workId": item.id,
                            "title": item.title,
                            "status": item.status,
                            "failureKind": failure_kinds.get(item.id, "code"),
                            "error": item.error,
                            "attempts": item.attempts,
                            "changedFiles": list(item.changed_files),
                        }
                        for item in failed
                    ],
                    failure_observation="\n\n".join(
                        failure_observations.get(work_id, work_id)
                        for work_id in failed_ids
                    ),
                    preferred_model_id=preferred_model_id,
                    credentials=credentials,
                )
                usage_add(total_usage, replan.usage)
                ledger.apply_replan(replan)
                if project_id.strip():
                    await skip_redundant_works(
                        root=root,
                        project_id=project_id,
                        ledger=ledger,
                    )
                transcript.append(
                    f"BATCH REPLAN {replan_round}: {replan.reason}\n"
                    f"FAILED: {failed_ids}\nSNAPSHOT: {ledger.snapshot()}"
                )
                for work_id in failed_ids:
                    state = worker_states.setdefault(work_id, WorkWorkerState())
                    state.quality["replanReason"] = replan.reason
                    state.append_transcript(
                        f"PLANNER REPLAN: {replan.reason}\n"
                        "只修复明确失败，不得重做已成功产物。"
                    )
                    failure_kinds.pop(work_id, None)
                    failure_observations.pop(work_id, None)
                await persist_checkpoint(force=True)
                yield AgentLoopEvent(
                    "usage",
                    {
                        "prompt": total_usage.prompt,
                        "completion": total_usage.completion,
                        "total": total_usage.total,
                    },
                )
                yield AgentLoopEvent("worklist", snapshot())
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
                continue

            blocked = [
                item
                for item in ledger.items
                if item.status not in {"succeeded", "skipped"}
            ]
            details = ", ".join(
                f"{item.id}(依赖:{item.dependencies})" for item in blocked
            )
            raise ValueError(f"WorkList 存在循环依赖或不可满足依赖：{details}")
    finally:
        if running:
            for task in running:
                task.cancel()
            await asyncio.gather(*running, return_exceptions=True)

    quality_report = await review_execution(
        root=root,
        changed_files=changed_files,
        command_results=command_results,
        worker_states=worker_states,
        execution_mode=execution_mode,
    )
    for command in quality_report.executed_commands:
        if command not in command_results:
            command_results.append(command)
    quality = quality_report.to_json()
    await persist_checkpoint(force=True)
    yield AgentLoopEvent("worklist", snapshot(quality=quality))
    yield AgentLoopEvent(
        "lifecycle",
        {
            "role": "reviewer_agent",
            "agentId": "reviewer_agent:final",
            "status": "completed" if quality.get("codeGatePassed") else "failed",
            "detail": (
                "已完成 Patch 风险、验证、回归和质量门审查。"
                if quality.get("codeGatePassed")
                else "最终质量门未通过，请查看验证或回归指标。"
            ),
            "iteration": replan_round,
        },
    )
    succeeded = sum(item.status == "succeeded" for item in ledger.items)
    skipped = sum(item.status == "skipped" for item in ledger.items)
    summary = f"已完成 {succeeded} 个 Work，跳过 {skipped} 个无需执行 Work。"
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
        iterations=base_iterations
        + sum(state.iterations for state in worker_states.values())
        + 1,
        replans=replan_round,
        optimized_prompt=task_plan.optimized_prompt,
        objective=task_plan.objective,
        worklist=snapshot(quality=quality),
        quality=quality,
    )
    yield AgentLoopEvent("result", result=result)
