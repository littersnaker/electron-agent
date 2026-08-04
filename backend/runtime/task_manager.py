"""统一 Runtime 的轻量任务状态管理器。"""

from __future__ import annotations

import asyncio
from uuid import uuid4

from backend.runtime.contracts import RuntimeStatus, RuntimeTask


class TaskManager:
    """在单个后端进程中保存正在执行的 Runtime 任务。"""

    def __init__(self) -> None:
        """创建任务字典和异步锁。"""

        # FastAPI 可能并发处理多个会话，所有状态写入都通过同一把锁保持一致。
        self._tasks: dict[str, RuntimeTask] = {}
        self._lock = asyncio.Lock()

    async def create(
        self,
        *,
        agent_id: str,
        session_id: str,
        project_id: str,
    ) -> RuntimeTask:
        """创建一条待执行任务并返回可继续更新的对象。"""

        task = RuntimeTask(
            id=f"rt_{uuid4().hex}",
            agent_id=agent_id,
            session_id=session_id,
            project_id=project_id,
        )
        async with self._lock:
            self._tasks[task.id] = task
        return task

    async def update(
        self,
        task_id: str,
        *,
        status: RuntimeStatus | None = None,
        error_message: str | None = None,
        event_increment: int = 0,
        metadata: dict[str, object] | None = None,
    ) -> RuntimeTask | None:
        """局部更新任务状态，并保留没有提供的旧字段。"""

        async with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                return None

            # 每个可选字段都单独判断，调用方无需复制完整任务对象。
            if status is not None:
                task.status = status
            if error_message is not None:
                task.error_message = error_message[:4_000]
            if event_increment:
                task.event_count += max(0, event_increment)
            if metadata:
                task.metadata.update(metadata)
            return task

    async def get(self, task_id: str) -> RuntimeTask | None:
        """按 ID 返回当前任务；不存在时返回 ``None``。"""

        async with self._lock:
            return self._tasks.get(task_id)

    async def snapshot(self) -> list[dict[str, object]]:
        """返回全部进程内任务的只读 JSON 快照。"""

        async with self._lock:
            return [task.to_json() for task in self._tasks.values()]

    async def discard_finished(self, *, keep: int = 100) -> None:
        """清理较早的终态任务，避免长时间运行后无限占用内存。"""

        async with self._lock:
            terminal = [
                task_id
                for task_id, task in self._tasks.items()
                if task.status in {"completed", "failed", "cancelled"}
            ]
            # 字典保持插入顺序，只删除超过保留数量的最早终态记录。
            for task_id in terminal[: max(0, len(terminal) - keep)]:
                self._tasks.pop(task_id, None)
