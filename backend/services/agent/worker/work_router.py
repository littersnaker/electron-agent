"""Work 类型路由器。

根据 Work 类型选择执行模式，避免所有 Work 都走 Agent LLM 调用。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from backend.services.agent.domain_rules import work_router_rules
from backend.services.agent.work_models import WorkItem


WorkHandler = Callable[..., Awaitable[Any]]

FACTORY_AUDIT_TERMS = tuple(
    str(item)
    for item in work_router_rules().get("factoryAuditTerms") or ()
)
FACTORY_TERMS = tuple(
    str(item)
    for item in work_router_rules().get("factoryTerms") or ()
)
PAGE_INTENT_TERMS = tuple(
    str(item)
    for item in work_router_rules().get("pageIntentTerms") or ()
)


def is_factory_audit_work(work: WorkItem) -> bool:
    """判断是否应走“工厂审计快速通道”：数据层审计/补齐，且不涉及页面接入。"""

    text = f"{work.title} {work.objective}".lower()
    has_audit = any(term in text for term in FACTORY_AUDIT_TERMS)
    has_factory = any(term in text for term in FACTORY_TERMS)
    has_page = any(term in text for term in PAGE_INTENT_TERMS)
    return has_audit and has_factory and not has_page


@dataclass(frozen=True, slots=True)
class RouteResult:
    """路由结果。"""

    handler_type: str
    handler: WorkHandler | None = None
    metadata: dict[str, Any] | None = None


class WorkRouter:
    """根据 Work 类型选择执行模式。"""

    # 执行模式分类
    HANDLER_FILESYSTEM = "FilesystemExecutor"
    HANDLER_CODING = "CodingWorker"
    HANDLER_FACTORY_AUDIT = "FactoryAuditWorker"
    HANDLER_VALIDATION = "ValidationWorker"
    HANDLER_ARTIFACT = "ArtifactWorker"
    HANDLER_UNKNOWN = "Unknown"

    def __init__(self) -> None:
        """初始化路由器。"""

        self._handlers: dict[str, WorkHandler] = {}

    def register(self, handler_type: str, handler: WorkHandler) -> None:
        """注册执行器。"""

        self._handlers[handler_type] = handler

    def route(self, work: WorkItem) -> RouteResult:
        """根据 Work 类型路由到对应执行器。

        分类：
        - filesystem: rename, move, delete 等直接执行
        - agent/coding: 调用 Agent LLM
        - validation: 调用测试执行
        - artifact: 调用 Artifact Engine
        """

        # 有 file_operations 时优先路由到 filesystem，无论 execution_type 标记
        if work.file_operations:
            return self._route_filesystem(work)

        execution_type = work.execution_type

        if execution_type == "filesystem":
            return self._route_filesystem(work)

        if execution_type == "agent":
            return self._route_agent(work)

        if execution_type == "validation":
            return self._route_validation(work)
        if execution_type == "artifact":
            return self._route_artifact(work)
        if execution_type == "coding":
            return self._route_coding(work)

        # 旧 Checkpoint 或未知类型继续根据标题和目标安全推断。
        return self._infer_route(work)

    def _route_filesystem(self, work: WorkItem) -> RouteResult:
        """路由文件系统操作。"""

        return RouteResult(
            handler_type=self.HANDLER_FILESYSTEM,
            handler=self._handlers.get(self.HANDLER_FILESYSTEM),
            metadata={
                "operations": [op.to_json() for op in work.file_operations],
                "work_id": work.id,
            },
        )

    def _route_agent(self, work: WorkItem) -> RouteResult:
        """路由 Agent 工作。进一步细分类型。"""

        title = work.title.lower()
        objective = work.objective.lower()

        # 检测是否为验证类工作
        validation_keywords = [
            "test",
            "验证",
            "lint",
            "typecheck",
            "build",
            "检查",
            "运行测试",
        ]
        if any(kw in title or kw in objective for kw in validation_keywords):
            return self._route_validation(work)

        # 数据层“审查/补齐”任务走单次 LLM 审计通道，避免 9 轮循环。
        if is_factory_audit_work(work):
            return self._route_factory_audit(work)

        # 检测是否为 Artifact 生成
        artifact_keywords = [
            "schema",
            "mock",
            "generate",
            "生成",
            "template",
            "模板",
            "data",
            "fixture",
        ]
        if any(kw in title or kw in objective for kw in artifact_keywords):
            return self._route_artifact(work)

        # 默认 Coding Worker。
        return self._route_coding(work)

    def _route_validation(self, work: WorkItem) -> RouteResult:
        """把验证 Work 路由到确定性质量命令执行器。"""

        return RouteResult(
            handler_type=self.HANDLER_VALIDATION,
            handler=self._handlers.get(self.HANDLER_VALIDATION),
            metadata={"work_id": work.id, "commands": list(work.validation_commands)},
        )

    def _route_artifact(self, work: WorkItem) -> RouteResult:
        """把产物生成 Work 路由到 Artifact Worker。"""

        return RouteResult(
            handler_type=self.HANDLER_ARTIFACT,
            handler=self._handlers.get(self.HANDLER_ARTIFACT),
            metadata={"work_id": work.id, "target_files": list(work.target_files)},
        )

    def _route_coding(self, work: WorkItem) -> RouteResult:
        """把普通代码理解和修改 Work 路由到 Coding Worker。"""

        if is_factory_audit_work(work):
            return self._route_factory_audit(work)
        return RouteResult(
            handler_type=self.HANDLER_CODING,
            handler=self._handlers.get(self.HANDLER_CODING),
            metadata={"work_id": work.id, "objective": work.objective},
        )

    def _route_factory_audit(self, work: WorkItem) -> RouteResult:
        """路由到单次 LLM 审计执行器。"""

        return RouteResult(
            handler_type=self.HANDLER_FACTORY_AUDIT,
            handler=self._handlers.get(self.HANDLER_FACTORY_AUDIT),
            metadata={"work_id": work.id, "objective": work.objective},
        )

    def _infer_route(self, work: WorkItem) -> RouteResult:
        """自动推断路由。"""

        if work.file_operations:
            return self._route_filesystem(work)
        return self._route_agent(work)

    def batch_route(self, works: list[WorkItem]) -> dict[str, list[RouteResult]]:
        """批量路由，按 handler_type 分组。"""

        groups: dict[str, list[RouteResult]] = {
            self.HANDLER_FILESYSTEM: [],
            self.HANDLER_CODING: [],
            self.HANDLER_FACTORY_AUDIT: [],
            self.HANDLER_VALIDATION: [],
            self.HANDLER_ARTIFACT: [],
        }
        for work in works:
            result = self.route(work)
            groups.setdefault(result.handler_type, []).append(result)
        return groups


__all__ = [
    "WorkRouter",
    "RouteResult",
    "WorkHandler",
]
