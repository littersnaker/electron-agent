"""统一 Agent Runtime Core。"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator

from backend.core import request_audit
from backend.services.agent.reflection.eval import schedule_memory_eval
from backend.services.agent.reflection.runner import schedule_runtime_review
from backend.services.evaluation import RuntimeEvaluator
from backend.services.glm46v import (
    builtin_skill_catalog,
    resolve_builtin_skills,
    split_registry_and_builtin_skill_ids,
)
from backend.services.memory import MemoryRouter
from backend.services.models import ModelRouter
from backend.services.runtime.agent_executor import AgentExecutor
from backend.services.runtime.agent_registry import AgentRegistry
from backend.services.runtime.context import ContextManager
from backend.services.runtime.contracts import RuntimeRequest
from backend.services.runtime.task_manager import TaskManager
from backend.services.skills import SkillRegistry
from backend.services.skills.installer import restore_installed_skills
from backend.services.tools.code_tools import register_code_tools

LOGGER = logging.getLogger(__name__)


class AgentRuntime:
    """统一加载 Agent、Memory、Skill、Context、Model 与执行器。"""

    def __init__(
        self,
        *,
        agent_registry: AgentRegistry,
        skill_registry: SkillRegistry,
        memory_router: MemoryRouter | None = None,
        context_manager: ContextManager | None = None,
        model_router: ModelRouter | None = None,
        executor: AgentExecutor | None = None,
        task_manager: TaskManager | None = None,
        evaluator: RuntimeEvaluator | None = None,
    ) -> None:
        """保存各系统依赖，并创建幂等初始化锁。"""

        self._agents = agent_registry
        self._skills = skill_registry
        self._memory = memory_router or MemoryRouter()
        self._context = context_manager or ContextManager()
        self._models = model_router or ModelRouter()
        self._executor = executor or AgentExecutor()
        self._tasks = task_manager or TaskManager()
        self._evaluator = evaluator or RuntimeEvaluator()
        self._initialized = False
        self._initialize_lock = asyncio.Lock()

    async def initialize(self) -> None:
        """幂等加载 Agent、Skill 和内置工具目录。"""

        if self._initialized:
            return
        async with self._initialize_lock:
            if self._initialized:
                return

            # 配置扫描和工具注册均为本地操作；全部成功后再标记初始化完成。
            try:
                restored = await restore_installed_skills()
                if restored:
                    LOGGER.info("启动恢复 %s 个外部安装的 Skill", restored)
            except Exception:
                LOGGER.warning("外部 Skill 恢复失败，继续使用现有文件", exc_info=True)
            self._agents.load()
            self._skills.load()
            register_code_tools()
            self._initialized = True
            LOGGER.info(
                "Agent Runtime 初始化完成：agents=%s skills=%s",
                len(self._agents.catalog()),
                len(self._skills.catalog()),
            )

    async def execute_stream(self, request: RuntimeRequest) -> AsyncIterator[str]:
        """按照统一流程执行 Agent，并持续返回业务层流式事件。"""

        await self.initialize()
        registered = self._agents.get(request.agent_id)
        task = await self._tasks.create(
            agent_id=registered.config.id,
            session_id=request.session_id,
            project_id=request.project_id,
        )
        await self._tasks.update(task.id, status="running")
        started_at = self._evaluator.begin()
        event_count = 0
        result_summary = ""
        audit_token = request_audit.push_audit_context(
            agent_id=request.agent_id,
            session_id=request.session_id,
            project_id=request.project_id,
            parent_request_id=task.id,
        )

        try:
            # Memory 作用域优先使用项目，其次使用会话；global 会由 Store 自动补充。
            scopes = tuple(
                item
                for item in (request.project_id.strip(), request.session_id.strip())
                if item
            )
            memories = await self._memory.search(
                memory_types=registered.config.memory,
                query=request.user_text,
                scope_ids=scopes,
                top_k=8,
            )
            registry_skill_ids, builtin_skill_ids = split_registry_and_builtin_skill_ids(
                registered.config.skills
            )
            fixed_skills = [
                *self._skills.resolve(registry_skill_ids),
                *resolve_builtin_skills(builtin_skill_ids),
            ]
            # 外部启用的 Skill 作为候选池：只取绑定当前 Agent 的已启用项，
            # 由打分器从候选里选 top 2 加载全文，避免全量注入造成上下文噪音。
            dynamic_skills = await self._select_enabled_skills(
                agent_id=registered.config.id,
                task_text=request.user_text,
            )
            skills = [*fixed_skills, *dynamic_skills]
            context = self._context.build(
                messages=request.messages,
                memories=memories,
                skills=skills,
                metadata={
                    "runtimeTaskId": task.id,
                    "agentId": registered.config.id,
                    "planner": registered.config.planner,
                },
            )
            model = self._models.select(
                preferred_model_id=request.preferred_model_id,
                task_text=request.user_text,
                context_tokens=context.estimated_tokens,
                requires_reasoning=any(skill.requires_reasoning for skill in skills),
            )
            await self._tasks.update(
                task.id,
                metadata={
                    "model": model.model_id,
                    "modelReason": model.reason,
                    "complexity": model.complexity,
                    "skillIds": list(context.skill_ids),
                    "memoryIds": list(context.memory_ids),
                    "estimatedContextTokens": context.estimated_tokens,
                },
            )

            async for event in self._executor.stream(
                agent=registered.adapter,
                request=request,
                context=context,
                model=model,
            ):
                event_count += 1
                await self._tasks.update(task.id, event_increment=1)
                yield event
                if isinstance(event, str) and event.startswith("data: "):
                    try:
                        parsed = json.loads(event[len("data: ") :])
                    except (json.JSONDecodeError, TypeError):
                        continue
                    if isinstance(parsed, dict) and parsed.get("type") == "TEXT":
                        result_summary = str(parsed.get("content") or "")[:4_000]

            evaluation = self._evaluator.finish(
                started_at=started_at,
                event_count=event_count,
                status="completed",
            )
            await self._tasks.update(
                task.id,
                status="completed",
                metadata={"evaluation": evaluation.to_json()},
            )
            await self._save_execution_memory(
                request=request,
                status="completed",
                event_count=event_count,
                task_id=task.id,
                result_summary=result_summary,
            )
            self._schedule_runtime_review(
                request=request,
                task_id=task.id,
                status="completed",
                event_count=event_count,
                result_summary=result_summary,
            )
            schedule_memory_eval(
                task_id=task.id,
                agent_id=request.agent_id,
                memory_ids=list(context.memory_ids),
            )
        except Exception as exc:
            evaluation = self._evaluator.finish(
                started_at=started_at,
                event_count=event_count,
                status="failed",
            )
            await self._tasks.update(
                task.id,
                status="failed",
                error_message=str(exc),
                metadata={"evaluation": evaluation.to_json()},
            )
            await self._save_execution_memory(
                request=request,
                status="failed",
                event_count=event_count,
                task_id=task.id,
                error_message=str(exc),
                result_summary=result_summary,
            )
            self._schedule_runtime_review(
                request=request,
                task_id=task.id,
                status="failed",
                event_count=event_count,
                error_message=str(exc),
                result_summary=result_summary,
            )
            schedule_memory_eval(
                task_id=task.id,
                agent_id=request.agent_id,
                memory_ids=list(context.memory_ids),
            )
            raise
        finally:
            request_audit.reset_audit_context(audit_token)
            await self._tasks.discard_finished()

    async def _select_enabled_skills(
        self,
        *,
        agent_id: str,
        task_text: str,
    ) -> list[SkillDefinition]:
        """从绑定当前 Agent 的启用 Skill 候选池中选出最相关的少量 Skill。"""

        from backend.services.skills.installer import (
            list_enabled_skills_for_agent,
            record_skill_usage,
        )
        from backend.services.skills.matcher import SkillMatcher

        try:
            candidates = await list_enabled_skills_for_agent(agent_id, limit=50)
        except Exception:
            # 数据库尚未初始化（如部分测试环境）时，跳过动态 Skill。
            return []
        if not candidates:
            return []
        selected = SkillMatcher().match(
            task_text=task_text,
            candidates=candidates,
            limit=2,
        )
        resolved: list[SkillDefinition] = []
        for item in selected:
            skill_id = (
                str(item["id"])
                if isinstance(item, dict)
                else item.id
            )
            try:
                resolved.append(self._skills.resolve((skill_id,))[0])
            except KeyError:
                continue
            try:
                await record_skill_usage(skill_id)
            except Exception:
                # 使用率统计失败不影响主流程。
                pass
        return resolved

    async def execute(self, request: RuntimeRequest) -> list[str]:
        """收集完整事件列表，供非流式调用方和测试使用。"""

        events: list[str] = []
        async for event in self.execute_stream(request):
            events.append(event)
        return events

    def catalog(self) -> dict[str, object]:
        """返回 Agent、Skill 和 Tool 的统一诊断目录。"""

        from backend.services.tools.gateway import TOOL_GATEWAY

        skills = list(self._skills.catalog())
        known_ids = {
            str(item.get("id") or "")
            for item in skills
            if isinstance(item, dict)
        }
        skills.extend(
            item
            for item in builtin_skill_catalog()
            if str(item.get("id") or "") not in known_ids
        )
        return {
            "agents": self._agents.catalog(),
            "skills": skills,
            "tools": TOOL_GATEWAY.catalog(),
        }

    async def task_snapshot(self) -> list[dict[str, object]]:
        """返回当前进程内 Runtime 任务快照。"""

        return await self._tasks.snapshot()

    def reload_skills(self) -> None:
        """重新扫描技能目录（审批落盘新技能后调用，使其立即生效）。"""

        self._skills.load()

    async def _save_execution_memory(
        self,
        *,
        request: RuntimeRequest,
        status: str,
        event_count: int,
        task_id: str,
        error_message: str = "",
        result_summary: str = "",
    ) -> None:
        """保存执行摘要；Memory 故障只记录日志，不覆盖已经完成的业务结果。"""

        try:
            await self._memory.save_execution_summary(
                session_id=request.session_id,
                project_id=request.project_id,
                agent_id=request.agent_id,
                request_text=request.user_text,
                status=status,
                event_count=event_count,
                result_summary=result_summary,
                metadata={
                    "runtimeTaskId": task_id,
                    "errorMessage": error_message[:1_000],
                },
            )
        except Exception:
            LOGGER.exception("保存 Runtime Episodic Memory 失败")

    def _schedule_runtime_review(
        self,
        *,
        request: RuntimeRequest,
        task_id: str,
        status: str,
        event_count: int,
        error_message: str = "",
        result_summary: str = "",
    ) -> None:
        """跨境电商 Agent 任务结束后触发异步复盘（fire-and-forget）。"""

        if request.agent_id != "commerce":
            return
        schedule_runtime_review(
            task_id=task_id,
            agent_id=request.agent_id,
            status=status,
            complexity=event_count,
            request_text=request.user_text,
            result_summary=result_summary,
            error_message=error_message,
            event_count=event_count,
            project_id=request.project_id,
            session_id=request.session_id,
            marketplace=str((request.metadata or {}).get("marketplace") or ""),
            credentials=request.credentials,
        )
