"""Task DAG 使用的数据结构和回调协议。"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

TaskHandler = Callable[[dict[str, Any]], Awaitable[Any]]
RollbackHandler = Callable[[Any], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class TaskDagNode:
    """表示 DAG 中一个可执行、可重试、可回滚的任务节点。"""

    id: str
    handler: TaskHandler
    dependencies: tuple[str, ...] = ()
    maximum_retries: int = 0
    rollback: RollbackHandler | None = None
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class TaskDagResult:
    """保存一次 DAG 执行的节点结果、顺序和重试次数。"""

    results: dict[str, Any]
    completion_order: tuple[str, ...]
    attempts: dict[str, int]
