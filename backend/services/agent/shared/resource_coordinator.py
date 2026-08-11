"""Code Agent 并行 Work 的资源冲突检测与优先级锁。"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import PurePosixPath

from backend.services.agent.shared.work_models import WorkItem

SPECIAL_TERMINAL_RESOURCE = "@terminal"


def normalize_resource(value: str) -> str:
    """把文件或逻辑资源统一成稳定、可比较的字符串。"""

    cleaned = str(value or "").strip().replace("\\", "/")
    if cleaned.startswith("@"):
        return cleaned.lower()
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    return PurePosixPath(cleaned).as_posix().strip("/").lower()


def resources_conflict(left: str, right: str) -> bool:
    """判断两个资源是否相同，或一个是另一个的父目录。"""

    first = normalize_resource(left)
    second = normalize_resource(right)
    if not first or not second:
        return False
    if first.startswith("@") or second.startswith("@"):
        return first == second
    return (
        first == second
        or first.startswith(f"{second}/")
        or second.startswith(f"{first}/")
    )


def _is_probable_directory(resource: str) -> bool:
    """判断 Planner 声明是否更像目录而不是具体文件。

    目录级 targetFiles 仅代表影响范围，不能在整个 Work 生命周期内充当静态写锁；
    真正写入时仍由 ``WorkspaceResourceCoordinator`` 按实际文件路径加锁。
    """

    normalized = normalize_resource(resource)
    if not normalized or normalized.startswith("@"):
        return False
    name = PurePosixPath(normalized).name
    known_extensionless_files = {
        "dockerfile",
        "makefile",
        "license",
        "readme",
        "procfile",
    }
    return "." not in name and name.lower() not in known_extensionless_files


def work_resources(work: WorkItem) -> set[str]:
    """返回 Planner 声明的写资源和可选串行组。"""

    resources = {
        normalize_resource(path)
        for path in work.target_files
        if path and not _is_probable_directory(path)
    }
    for operation in work.file_operations:
        if operation.source_path:
            resources.add(normalize_resource(operation.source_path))
        if operation.target_path:
            resources.add(normalize_resource(operation.target_path))
    if work.serial_group:
        resources.add(f"@group:{work.serial_group.strip().lower()}")
    return {item for item in resources if item}


def works_conflict(left: WorkItem, right: WorkItem) -> bool:
    """根据精确目标文件和串行组判断两个 Work 是否必须串行。

    静态调度只阻止相同具体文件或相同逻辑组并发；父目录影响范围不再提前锁死
    整个 Work。实际编辑仍使用父子路径冲突规则，保证写入安全。
    """

    left_resources = work_resources(left)
    right_resources = work_resources(right)
    for first in left_resources:
        for second in right_resources:
            if first.startswith("@") or second.startswith("@"):
                if first == second:
                    return True
            elif first == second:
                return True
    return False


def max_parallel_workers() -> int:
    """读取并行度；它限制同时请求数，不限制 Work 或文件总数量。"""

    raw = os.getenv("CODE_AGENT_PARALLEL_WORKERS", "4").strip()
    try:
        value = int(raw)
    except ValueError:
        value = 4
    return max(1, min(value, 16))


def select_parallel_wave(ready: list[WorkItem], limit: int) -> list[WorkItem]:
    """选择一个互不冲突的执行波次，冲突项按优先级留到下一波。"""

    selected: list[WorkItem] = []
    for work in sorted(ready, key=lambda item: (item.priority, item.id)):
        if len(selected) >= max(1, limit):
            break
        if any(works_conflict(work, active) for active in selected):
            continue
        selected.append(work)
    return selected or ready[:1]


def select_parallel_candidates(
    ready: list[WorkItem],
    active: list[WorkItem],
    limit: int,
) -> list[WorkItem]:
    """为滚动任务池选择不会与当前运行 Work 冲突的新工作项。"""

    if limit <= 0:
        return []
    selected: list[WorkItem] = []
    for work in sorted(ready, key=lambda item: (item.priority, item.id)):
        if len(selected) >= limit:
            break
        blockers = [*active, *selected]
        if any(works_conflict(work, running) for running in blockers):
            continue
        selected.append(work)
    return selected


@dataclass(slots=True)
class _Waiter:
    """等待一组资源的优先级请求。"""

    owner: str
    resources: frozenset[str]
    priority: int
    sequence: int


class WorkspaceResourceCoordinator:
    """以原子方式锁定多文件资源，避免并行 Work 发生交叉写入。"""

    def __init__(self) -> None:
        """初始化条件变量、活动资源和优先级等待队列。"""

        self._condition = asyncio.Condition()
        self._active: dict[str, str] = {}
        self._waiters: list[_Waiter] = []
        self._sequence = 0

    def _active_conflict(self, waiter: _Waiter) -> bool:
        """判断等待请求是否与当前活动资源冲突。"""

        return any(
            resources_conflict(requested, active)
            for requested in waiter.resources
            for active in self._active
        )

    def _earlier_conflicting_waiter(self, waiter: _Waiter) -> bool:
        """让相同资源按 priority、进入顺序稳定串行。"""

        rank = (waiter.priority, waiter.sequence)
        for other in self._waiters:
            if other is waiter or (other.priority, other.sequence) >= rank:
                continue
            if any(
                resources_conflict(first, second)
                for first in waiter.resources
                for second in other.resources
            ):
                return True
        return False

    @asynccontextmanager
    async def reserve(
        self,
        resources: set[str] | list[str],
        *,
        owner: str,
        priority: int,
    ) -> AsyncIterator[None]:
        """按优先级原子锁定资源集合，并在退出时唤醒其他 Work。"""

        normalized = frozenset(
            resource
            for resource in (normalize_resource(item) for item in resources)
            if resource
        )
        if not normalized:
            yield
            return

        async with self._condition:
            self._sequence += 1
            waiter = _Waiter(owner, normalized, priority, self._sequence)
            self._waiters.append(waiter)
            await self._condition.wait_for(
                lambda: not self._active_conflict(waiter)
                and not self._earlier_conflicting_waiter(waiter)
            )
            self._waiters.remove(waiter)
            for resource in normalized:
                self._active[resource] = owner

        try:
            yield
        finally:
            async with self._condition:
                for resource in normalized:
                    if self._active.get(resource) == owner:
                        self._active.pop(resource, None)
                self._condition.notify_all()
