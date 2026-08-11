"""支持依赖、并行、重试和回滚的轻量 Task DAG Executor。"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

from backend.runtime.dag.contracts import TaskDagNode, TaskDagResult


@dataclass(frozen=True, slots=True)
class _NodeOutcome:
    """保存单个节点的一次最终执行结果。"""

    node_id: str
    value: Any
    attempts: int


class TaskDagExecutionError(RuntimeError):
    """表示 DAG 节点失败，并保留失败节点和原始异常。"""

    def __init__(self, node_id: str, cause: BaseException) -> None:
        """创建包含节点 ID 的可诊断异常。"""

        super().__init__(f"Task DAG 节点执行失败：{node_id}：{cause}")
        self.node_id = node_id
        self.cause = cause


class TaskDagExecutor:
    """按拓扑依赖执行任务，允许同层节点并行。"""

    def __init__(self, *, maximum_concurrency: int = 4) -> None:
        """保存全局并发上限，避免复杂任务一次创建过多协程。"""

        self._maximum_concurrency = max(1, min(maximum_concurrency, 32))

    async def execute(self, nodes: list[TaskDagNode]) -> TaskDagResult:
        """验证并执行 DAG；任一节点失败时按完成顺序反向回滚。"""

        node_map = self._validate(nodes)
        pending = set(node_map)
        results: dict[str, Any] = {}
        attempts: dict[str, int] = {}
        completion_order: list[str] = []

        while pending:
            # 只有依赖全部成功的节点才进入当前批次；同一批次之间互不依赖，可安全并行。
            ready = [
                node_map[node_id]
                for node_id in sorted(pending)
                if set(node_map[node_id].dependencies).issubset(results)
            ]
            if not ready:
                # _validate 已检查静态环；这里仍保留运行期防御，避免后续扩展破坏不变量。
                raise ValueError("Task DAG 无可执行节点，可能存在循环依赖")

            outcomes = await self._execute_batch(ready, results)
            batch_error: TaskDagExecutionError | None = None
            for node, outcome in zip(ready, outcomes, strict=True):
                if isinstance(outcome, BaseException):
                    if batch_error is None:
                        batch_error = TaskDagExecutionError(node.id, outcome)
                    continue
                results[outcome.node_id] = outcome.value
                attempts[outcome.node_id] = outcome.attempts
                completion_order.append(outcome.node_id)
                pending.remove(outcome.node_id)

            if batch_error is not None:
                await self._rollback(
                    node_map=node_map,
                    completion_order=completion_order,
                    results=results,
                )
                raise batch_error

        return TaskDagResult(
            results=dict(results),
            completion_order=tuple(completion_order),
            attempts=dict(attempts),
        )

    async def _execute_batch(
        self,
        nodes: list[TaskDagNode],
        completed_results: dict[str, Any],
    ) -> list[_NodeOutcome | BaseException]:
        """并行执行同一拓扑层，并把异常作为结果返回给统一回滚逻辑。"""

        semaphore = asyncio.Semaphore(self._maximum_concurrency)

        async def run_with_limit(node: TaskDagNode) -> _NodeOutcome:
            """在共享信号量内执行一个节点。"""

            async with semaphore:
                return await self._execute_node(node, completed_results)

        return list(
            await asyncio.gather(
                *(run_with_limit(node) for node in nodes),
                return_exceptions=True,
            )
        )

    async def _execute_node(
        self,
        node: TaskDagNode,
        completed_results: dict[str, Any],
    ) -> _NodeOutcome:
        """执行单个节点，并在有限次数内重试暂时性失败。"""

        maximum_attempts = 1 + max(0, min(node.maximum_retries, 10))
        last_error: BaseException | None = None
        for attempt in range(1, maximum_attempts + 1):
            try:
                # 只传入已经完成的依赖结果副本，防止节点意外修改 Executor 内部状态。
                dependency_results = {
                    dependency: completed_results[dependency]
                    for dependency in node.dependencies
                }
                value = await node.handler(dependency_results)
                return _NodeOutcome(node.id, value, attempt)
            except asyncio.CancelledError:
                # 取消信号必须立即向上传递，不能被普通重试吞掉。
                raise
            except BaseException as exc:
                last_error = exc
                if attempt < maximum_attempts:
                    await asyncio.sleep(min(0.1 * attempt, 0.5))

        if last_error is not None:
            raise last_error
        raise RuntimeError(f"Task DAG 节点未执行：{node.id}")

    async def _rollback(
        self,
        *,
        node_map: dict[str, TaskDagNode],
        completion_order: list[str],
        results: dict[str, Any],
    ) -> None:
        """按完成顺序反向调用回滚函数；回滚失败不会遮盖原始执行异常。"""

        for node_id in reversed(completion_order):
            rollback = node_map[node_id].rollback
            if rollback is None:
                continue
            try:
                await rollback(results[node_id])
            except Exception:
                # Runtime 日志层可记录回滚失败；这里继续处理其余节点，尽量恢复更多副作用。
                continue

    def _validate(self, nodes: list[TaskDagNode]) -> dict[str, TaskDagNode]:
        """校验节点 ID、依赖存在性和循环依赖。"""

        node_map: dict[str, TaskDagNode] = {}
        for node in nodes:
            identifier = node.id.strip()
            if not identifier:
                raise ValueError("Task DAG 节点 ID 不能为空")
            if identifier != node.id:
                # 节点 ID 会作为结果字典和依赖关系的稳定键，首尾空格会造成难以发现的键不一致。
                raise ValueError(f"Task DAG 节点 ID 不能包含首尾空格：{node.id!r}")
            invalid_dependencies = [
                dependency
                for dependency in node.dependencies
                if not dependency.strip() or dependency != dependency.strip()
            ]
            if invalid_dependencies:
                # 依赖 ID 与节点 ID 使用同一套规范，避免拓扑校验通过后在执行阶段读取失败。
                raise ValueError(
                    f"Task DAG 节点 {node.id} 的依赖 ID 不能为空或包含首尾空格"
                )
            if identifier in node_map:
                raise ValueError(f"Task DAG 节点 ID 重复：{identifier}")
            node_map[identifier] = node

        for node in node_map.values():
            missing = sorted(set(node.dependencies) - set(node_map))
            if missing:
                raise ValueError(f"Task DAG 节点 {node.id} 依赖不存在：{', '.join(missing)}")
            if node.id in node.dependencies:
                raise ValueError(f"Task DAG 节点不能依赖自身：{node.id}")

        # 使用 Kahn 算法进行静态拓扑检查；处理副本，不修改节点配置。
        remaining_dependencies = {
            node.id: set(node.dependencies) for node in node_map.values()
        }
        resolved: set[str] = set()
        while len(resolved) < len(node_map):
            ready = {
                node_id
                for node_id, dependencies in remaining_dependencies.items()
                if node_id not in resolved and dependencies.issubset(resolved)
            }
            if not ready:
                raise ValueError("Task DAG 存在循环依赖")
            resolved.update(ready)
        return node_map
