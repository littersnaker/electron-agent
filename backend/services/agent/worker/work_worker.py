"""单个 Code Agent Work 的独立工具循环。

批量直写快速路径、生成/审查路径、Worker 提示词分别拆到
work_batch_writer / work_generation / work_prompt，本模块保留多轮
ReAct 主循环 execute_work，并 re-export 这些符号以兼容既有调用方。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from backend.services.agent.harness import ProjectHarness, build_work_seed_context
from backend.services.agent.planner.task_planner import CodeTaskPlan
from backend.services.agent.runtime.execution_guard import (
    ExecutionLimits,
    WorkExecutionGuard,
)
from backend.services.agent.runtime.work_session import WorkIntelligenceSession
from backend.services.agent.shared.loop_protocol import parse_agent_action
from backend.services.agent.shared.loop_support import ExecutionMode, usage_add
from backend.services.agent.shared.resource_coordinator import WorkspaceResourceCoordinator
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import (
    CheckpointCallback,
    EmitCallback,
    WorkExecutionResult,
    WorkWorkerState,
)
from backend.services.agent.worker.work_action_handler import (
    WorkActionEnvironment,
    WorkActionHandler,
)
from backend.services.agent.worker.work_batch_writer import _env_int, _try_batch_write
from backend.services.agent.worker.work_generation import _try_write_then_review
from backend.services.agent.worker.work_prompt import (
    _action_files,
    _action_status,
    _failure_kind,
    _worker_prompt,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.protocols import ProviderRequestError
from backend.services.llm.types import LlmMessage

LOGGER = logging.getLogger(__name__)
MAX_INVALID_PROTOCOL_ROUNDS = 3
# 单轮模型输出上限：超过说明模型在整文件重写或冗余输出，注入警告引导精确修改。
MAX_WORK_OUTPUT_TOKENS = _env_int("CODE_AGENT_MAX_OUTPUT_TOKENS", 8_000, 1_000, 200_000)


async def execute_work(
    *,
    root: Path,
    task_plan: CodeTaskPlan,
    work: WorkItem,
    harness: ProjectHarness,
    initial_context: str,
    project_tree: str,
    ledger_snapshot: dict[str, Any],
    preferred_model_id: str,
    credentials: LlmCredentials,
    execution_mode: ExecutionMode,
    coordinator: WorkspaceResourceCoordinator,
    state: WorkWorkerState,
    emit: EmitCallback,
    checkpoint: CheckpointCallback,
    slot: int,
) -> WorkExecutionResult:
    """持续执行一个 Work，直到成功完成或产生可分类的真实失败。"""

    session = WorkIntelligenceSession(work, state)
    session.initialize(
        initial_context=initial_context,
        project_tree=project_tree,
        ledger_snapshot=ledger_snapshot,
        harness_context=build_work_seed_context(
            root=root,
            harness=harness,
            work=work,
        ),
        root=root,
    )
    agent_id = f"modify_worker:{work.id}"
    guard = WorkExecutionGuard(
        state,
        limits=ExecutionLimits.from_environment(len(work.target_files)),
    )
    consecutive_context_actions = 0
    handler = WorkActionHandler(
        WorkActionEnvironment(
            root=root,
            request_text=task_plan.raw_request,
            work=work,
            state=state,
            execution_mode=execution_mode,
            coordinator=coordinator,
            emit=emit,
            checkpoint=checkpoint,
            slot=slot,
            agent_id=agent_id,
        )
    )

    if work.execution_type in {"coding", "agent"}:
        batch_result, batch_reason = await _try_batch_write(
            root=root,
            work=work,
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            execution_mode=execution_mode,
            coordinator=coordinator,
            state=state,
            emit=emit,
            checkpoint=checkpoint,
            slot=slot,
        )
        if batch_result is not None:
            return batch_result
        if batch_reason not in {"disabled", "transcript"}:
            fast_result = await _try_write_then_review(
                root=root,
                work=work,
                preferred_model_id=preferred_model_id,
                credentials=credentials,
                execution_mode=execution_mode,
                coordinator=coordinator,
                state=state,
                emit=emit,
                checkpoint=checkpoint,
                slot=slot,
            )
            if fast_result is not None:
                return fast_result

    if state.attempt_number > 1:
        retry_reason = (
            str(dict(state.failure_summary).get("error") or "")
            if state.failure_summary
            else ""
        )
        await emit(
            "lifecycle",
            {
                "role": "modify_worker",
                "agentId": agent_id,
                "slot": slot,
                "status": "running",
                "detail": (
                    f"{work.id} · {work.title}：正在重试"
                    f"（第 {state.attempt_number} 次尝试）"
                    f"——上次失败原因：{(retry_reason or '未知')[:160]}"
                ),
            },
        )

    while True:
        model_gate = guard.before_model_call()
        if model_gate.stop:
            session.record_failure(action="execution_guard", error=model_gate.error)
            state.runtime_failures += 1
            await checkpoint()
            return WorkExecutionResult(
                work.id,
                False,
                "",
                model_gate.error,
                state,
                failure_kind="guard",
            )

        session_prompt = session.build_prompt()
        worker_budget = session.budget.get("worker")
        if (
            worker_budget.consumed > 0
            and worker_budget.remaining
            < session_prompt.estimated_tokens + 2_000
        ):
            # 预算不再作为调用前硬闸门：先压缩上下文腾出空间，再通过软信号
            # 引导模型本轮收尾（edit 或 complete_work），而不是直接失败交回 Planner。
            session.compact_for_budget()
            session_prompt = session.build_prompt()
        budget_hint = session.budget_directive(
            worker_budget,
            session_prompt.estimated_tokens,
        )
        user_text = f"{session_prompt.text}\n\n{guard.prompt_directive()}"
        if budget_hint:
            user_text = f"{user_text}\n\n{budget_hint}"
        next_attempt_iteration = state.attempt_iterations + 1
        attempt_note = (
            f" · 第 {state.attempt_number} 次尝试"
            if state.attempt_number > 1
            else ""
        )
        await emit(
            "lifecycle",
            {
                "role": "modify_worker",
                "agentId": agent_id,
                "slot": slot,
                "status": "running",
                "detail": (
                    f"{work.id} · {work.title}：正在执行第 "
                    f"{next_attempt_iteration} 轮{attempt_note}（输入约 "
                    f"{session_prompt.estimated_tokens} Tokens）"
                ),
            },
        )
        LOGGER.info(
            "Worker 模型调用开始 work=%s attempt=%s iteration=%s prompt_tokens=%s",
            work.id,
            state.attempt_number,
            next_attempt_iteration,
            session_prompt.estimated_tokens,
        )
        try:
            text, usage, model = await GATEWAY.complete(
                preferred_model_id=preferred_model_id,
                credentials=credentials,
                messages=[
                    LlmMessage(
                        "system",
                        _worker_prompt(work, harness, execution_mode, state),
                    ),
                    LlmMessage(
                        "user",
                        user_text,
                    ),
                ],
                temperature=0.1,
                timeout_seconds=guard.limits.model_timeout_seconds,
                stall_timeout_seconds=90.0,
                audit={
                    "agentId": agent_id,
                    "agentRole": "worker_loop",
                    "parentRequestId": work.id,
                },
            )
        except (TimeoutError, ProviderRequestError) as exc:
            if isinstance(exc, ProviderRequestError) and "超时" not in str(exc):
                raise
            error = (
                f"模型响应超时：{str(exc)}"
                "。已终止本次尝试，避免长期占用执行槽。"
            )
            session.record_failure(action="model_timeout", error=error)
            state.runtime_failures += 1
            await checkpoint()
            return WorkExecutionResult(
                work.id,
                False,
                "",
                error,
                state,
                failure_kind="runtime",
            )

        usage_add(state.usage, usage)
        if not session.record_usage(usage.total):
            worker_budget = dict(state.token_budget.get("worker") or {})
            budget_limit = int(worker_budget.get("limit") or 0)
            error = (
                "Worker Token 预算严重超限且已完成一次上下文压缩"
                f"（已消耗 {worker_budget.get('consumed') or 0} / "
                f"触发终止阈值 {budget_limit * 2} Tokens；"
                f"单 Work 预算上限 {budget_limit or '未知'}）。"
                "压缩后仍无法收尾，停止继续消耗。"
            )
            session.record_failure(action="token_budget", error=error)
            state.runtime_failures += 1
            await checkpoint()
            return WorkExecutionResult(
                work.id,
                False,
                "",
                error,
                state,
                failure_kind="guard",
            )
        state.model_name = model.name
        state.iterations += 1
        state.attempt_iterations += 1
        await emit(
            "usage",
            {
                "workId": work.id,
                "prompt": usage.prompt,
                "completion": usage.completion,
                "total": usage.total,
            },
        )
        LOGGER.info(
            "Worker 模型调用完成 work=%s attempt=%s iteration=%s total_tokens=%s",
            work.id,
            state.attempt_number,
            state.attempt_iterations,
            usage.total,
        )

        # 大输出监控：单轮 completion 过大说明模型在整文件重写或冗余输出，
        # 注入警告引导下一轮改用多组 replace 精确修改；连续两次升级措辞促收尾。
        if usage.completion > MAX_WORK_OUTPUT_TOKENS:
            large_outputs = int(state.quality.get("largeOutputCount") or 0) + 1
            state.quality["largeOutputCount"] = large_outputs
            if large_outputs >= 2:
                state.append_transcript(
                    f"LARGE OUTPUT WARNING（第 {large_outputs} 次）：上一轮输出 "
                    f"{usage.completion} Tokens，已连续大段输出。禁止整文件 write "
                    "重写，改用多组 replace 精确修改缺失部分，并在本轮 complete_work "
                    "收尾；继续超大输出会拖慢执行并浪费 Token。"
                )
            else:
                state.append_transcript(
                    f"LARGE OUTPUT WARNING：上一轮输出 {usage.completion} Tokens，"
                    f"超出单轮上限 {MAX_WORK_OUTPUT_TOKENS}。请改用多组 replace "
                    "精确修改，禁止整文件 write 重写；输出只包含必要变更。"
                )

        try:
            action = parse_agent_action(text)
            state.invalid_rounds = 0
            state.attempt_invalid_rounds = 0
        except ValueError as exc:
            state.invalid_rounds += 1
            state.attempt_invalid_rounds += 1
            bad_preview = " ".join(text.split())[:400]
            error_text = str(exc)
            if "read" in error_text:
                example = '{"action":"read","workId":"W001","paths":["src/mock/user.ts"]}'
            elif "inspect" in error_text:
                example = '{"action":"inspect","workId":"W001","paths":["src/mock/user.ts"],"query":"数据源"}'
            elif "search" in error_text:
                example = '{"action":"search","workId":"W001","query":"cart"}'
            else:
                example = "参考工具目录中对应动作的示例 JSON"
            feedback = (
                f"直接复制下面示例 JSON，只替换路径和 ID，不要改变结构：{example}\n"
                f"PROTOCOL ERROR: {exc}\n"
                f"上一轮输出（截断）：{bad_preview or '（空输出）'}\n"
                "下一轮必须只返回一个合法 JSON 动作，不得附加 Markdown 或解释。"
            )
            if "非空 operations" in error_text:
                feedback += (
                    "\n如果目标文件已满足验收标准或无法确定修改点，请直接返回 "
                    '{"action":"complete_work","workId":"W001","summary":"说明原因"}，'
                    "不要返回空 operations 的 edit。"
                )
            if state.attempt_invalid_rounds >= 3:
                feedback += (
                    "\n严重警告：已连续 3 次协议错误。下一轮请直接复制上面的示例并只替换"
                    "路径与 ID，不要改变 JSON 结构；再错将终止本次尝试。"
                )
            state.append_transcript(feedback)
            if state.attempt_invalid_rounds >= MAX_INVALID_PROTOCOL_ROUNDS:
                error = f"模型连续返回无效工具协议：{exc}"
                session.record_failure(action="protocol", error=error)
                state.runtime_failures += 1
                await checkpoint()
                return WorkExecutionResult(
                    work.id,
                    False,
                    "",
                    error,
                    state,
                    failure_kind="runtime",
                )
            continue

        if action.work_id and action.work_id != work.id:
            state.append_transcript(
                f"WORK ID ERROR: 当前只能处理 {work.id}，不能处理 {action.work_id}。"
            )
            continue
        if action.action == "finish":
            state.append_transcript(
                "FINISH REJECTED: 并行 Worker 必须使用 complete_work。"
            )
            continue
        if action.action == "edit" and not action.operations:
            state.append_transcript(
                "EMPTY EDIT REJECTED: edit 必须包含 operations；"
                "如果目标已满足或无法确定修改点，请用 complete_work 结束，不要返回空 edit。"
            )
            continue

        action_gate = guard.before_action(action)
        if not action_gate.allowed:
            state.append_transcript(action_gate.feedback or action_gate.error)
            await checkpoint()
            if action_gate.stop:
                error = action_gate.error or "执行守卫已终止重复动作。"
                session.record_failure(action=action.action, error=error)
                state.runtime_failures += 1
                await checkpoint()
                return WorkExecutionResult(
                    work.id,
                    False,
                    "",
                    error,
                    state,
                    failure_kind="guard",
                )
            continue

        await emit(
            "lifecycle",
            {
                "role": "modify_worker",
                "agentId": agent_id,
                "slot": slot,
                "status": "running",
                "detail": _action_status(action, work),
                "currentFiles": _action_files(action),
            },
        )
        outcome = await handler.execute(action)
        if action.action in {"search", "read", "inspect"}:
            consecutive_context_actions += 1
        else:
            consecutive_context_actions = 0
        if consecutive_context_actions >= 3:
            state.append_transcript(
                "READ-ONLY STALL WARNING: 已连续 3 轮只读动作。"
                "下一轮必须输出 edit、factory、run 或 complete_work；"
                "继续只读取会导致本 Work 被终止并交给 Planner。"
            )
            consecutive_context_actions = 0
        guard.record(
            action,
            outcome.kind,
            progress_made=outcome.progress_made,
            refresh_context=outcome.refresh_context,
        )
        session.reflect(
            action=action.action,
            outcome_kind=outcome.kind,
            summary=outcome.summary,
            error=outcome.error,
        )
        if outcome.kind == "continue":
            continue
        if outcome.kind == "failure":
            session.record_failure(action=action.action, error=outcome.error)
            await checkpoint()
            return WorkExecutionResult(
                work.id,
                False,
                "",
                outcome.error,
                state,
                failure_kind=_failure_kind(outcome.error),
            )
        return WorkExecutionResult(
            work.id,
            True,
            outcome.summary,
            "",
            state,
        )


__all__ = [
    "EmitCallback",
    "CheckpointCallback",
    "WorkExecutionResult",
    "WorkWorkerState",
    "_worker_prompt",
    "_try_batch_write",
    "_try_write_then_review",
    "execute_work",
]
