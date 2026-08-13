"""根据 Work Router 把工作项分发到确定性执行器或 Coding Worker。"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from backend.services.agent.harness import ProjectHarness
from backend.services.agent.planner.task_planner import CodeTaskPlan
from backend.services.agent.shared.loop_support import ExecutionMode
from backend.services.agent.shared.resource_coordinator import WorkspaceResourceCoordinator
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.shared.work_state import (
    CheckpointCallback,
    EmitCallback,
    WorkExecutionResult,
    WorkWorkerState,
)
from backend.services.agent.worker.factory_audit_work import execute_factory_audit_work
from backend.services.agent.worker.factory_work import (
    execute_factory_validation_work,
    execute_factory_work,
)
from backend.services.agent.worker.fast_work import execute_fast_filesystem_work
from backend.services.agent.worker.validation_work import execute_validation_work
from backend.services.agent.worker.work_router import WorkRouter
from backend.services.agent.worker.work_worker import execute_work
from backend.services.llm.credentials import LlmCredentials


@dataclass(slots=True)
class WorkDispatchEnvironment:
    """保存所有执行器共享的稳定依赖，避免调度循环重复分支。"""

    root: Path
    task_plan: CodeTaskPlan
    harness: ProjectHarness
    initial_context: str
    project_tree: str
    preferred_model_id: str
    credentials: LlmCredentials
    execution_mode: ExecutionMode
    coordinator: WorkspaceResourceCoordinator
    emit: EmitCallback
    checkpoint: CheckpointCallback
    session_id: str = ""
    checkpoint_id: str = ""


class WorkDispatcher:
    """调用 WorkRouter 后执行本地快速路径或 LLM Coding Worker。"""

    def __init__(self, environment: WorkDispatchEnvironment) -> None:
        """保存共享执行环境并创建无状态路由器。"""

        self._env = environment
        self._router = WorkRouter()

    async def execute(
        self,
        *,
        work: WorkItem,
        state: WorkWorkerState,
        slot: int,
        ledger_snapshot: dict[str, object],
    ) -> WorkExecutionResult:
        """执行一个 Work，并保持原有接口与状态合并方式。"""

        route = self._router.route(work)
        if route.handler_type == WorkRouter.HANDLER_FILESYSTEM and work.file_operations:
            return await execute_fast_filesystem_work(
                root=self._env.root,
                work=work,
                coordinator=self._env.coordinator,
                state=state,
                emit=self._env.emit,
                checkpoint=self._env.checkpoint,
                slot=slot,
            )
        if route.handler_type == WorkRouter.HANDLER_ARTIFACT:
            return await execute_factory_work(
                root=self._env.root,
                request_text=self._env.task_plan.raw_request,
                work=work,
                harness=self._env.harness,
                state=state,
                emit=self._env.emit,
                checkpoint=self._env.checkpoint,
                slot=slot,
            )
        if route.handler_type == WorkRouter.HANDLER_FACTORY_AUDIT:
            return await execute_factory_audit_work(
                root=self._env.root,
                request_text=self._env.task_plan.raw_request,
                work=work,
                harness=self._env.harness,
                preferred_model_id=self._env.preferred_model_id,
                credentials=self._env.credentials,
                state=state,
                emit=self._env.emit,
                checkpoint=self._env.checkpoint,
                slot=slot,
            )
        if route.handler_type == WorkRouter.HANDLER_VALIDATION:
            return await self._execute_validation(work=work, state=state, slot=slot)
        return await execute_work(
            root=self._env.root,
            task_plan=self._env.task_plan,
            work=work,
            harness=self._env.harness,
            initial_context=self._env.initial_context,
            project_tree=self._env.project_tree,
            ledger_snapshot=ledger_snapshot,
            preferred_model_id=self._env.preferred_model_id,
            credentials=self._env.credentials,
            execution_mode=self._env.execution_mode,
            coordinator=self._env.coordinator,
            state=state,
            emit=self._env.emit,
            checkpoint=self._env.checkpoint,
            slot=slot,
            session_id=self._env.session_id,
            checkpoint_id=self._env.checkpoint_id,
        )

    async def _execute_validation(
        self,
        *,
        work: WorkItem,
        state: WorkWorkerState,
        slot: int,
    ) -> WorkExecutionResult:
        """区分 Factory 闭环校验和普通项目质量命令。"""

        validation_text = f"{work.title} {work.objective}".lower()
        if any(
            term in validation_text
            for term in ("factory", "契约", "mock", "数据闭环")
        ):
            return await execute_factory_validation_work(
                root=self._env.root,
                work=work,
                harness=self._env.harness,
                state=state,
                execution_mode=self._env.execution_mode,
                emit=self._env.emit,
                checkpoint=self._env.checkpoint,
                slot=slot,
            )
        commands = list(work.validation_commands) or list(
            self._env.harness.quality_commands
        )
        return await execute_validation_work(
            root=self._env.root,
            work=work,
            commands=commands,
            state=state,
            execution_mode=self._env.execution_mode,
            emit=self._env.emit,
            checkpoint=self._env.checkpoint,
            slot=slot,
        )


__all__ = ["WorkDispatchEnvironment", "WorkDispatcher"]
