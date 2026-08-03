"""Work Context 存储管理器。

为每个 Work 提供独立的上下文加载、保存和清理能力，避免全局 transcript 污染。
"""

from __future__ import annotations

from typing import Any

from backend.services.agent.context.work_context import WorkContext


class ContextStore:
    """内存级 Work Context 存储；可替换为持久化实现。"""

    def __init__(self) -> None:
        """初始化空存储。"""

        self._store: dict[str, WorkContext] = {}

    def get(self, work_id: str) -> WorkContext | None:
        """按 work_id 获取上下文。"""

        return self._store.get(work_id)

    def create(self, work_id: str, objective: str = "") -> WorkContext:
        """为新 Work 创建独立上下文。"""

        ctx = WorkContext(work_id=work_id, objective=objective)
        self._store[work_id] = ctx
        return ctx

    def save(self, ctx: WorkContext) -> None:
        """保存或更新上下文。"""

        self._store[ctx.work_id] = ctx

    def delete(self, work_id: str) -> bool:
        """删除上下文并返回是否成功。"""

        return bool(self._store.pop(work_id, None))

    def list_work_ids(self) -> list[str]:
        """返回所有已存储的 work_id。"""

        return list(self._store.keys())

    def snapshot(self) -> dict[str, dict[str, Any]]:
        """导出全部上下文快照，用于 Checkpoint 恢复。"""

        return {wid: ctx.to_json() for wid, ctx in self._store.items()}

    def restore(self, snapshot: dict[str, dict[str, Any]]) -> None:
        """从快照恢复全部上下文。"""

        self._store = {
            wid: WorkContext.from_json(data) for wid, data in snapshot.items()
        }

    def clear(self) -> None:
        """清空全部存储。"""

        self._store.clear()
