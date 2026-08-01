"""Code Agent Work 数据模型与并发安全状态台账。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

WorkStatus = Literal["pending", "running", "succeeded", "failed", "skipped"]
WorkExecutionType = Literal["agent", "filesystem"]
FileOperationType = Literal["rename", "move", "delete_empty_dir"]


@dataclass(slots=True)
class FileSystemOperation:
    """无需大模型参与即可执行的确定性文件系统操作。"""

    type: FileOperationType
    source_path: str
    target_path: str = ""

    def to_json(self) -> dict[str, str]:
        """转换成 Planner、Checkpoint 和前端共用的稳定 JSON。"""

        return {
            "type": self.type,
            "sourcePath": self.source_path,
            "targetPath": self.target_path,
        }


@dataclass(slots=True)
class WorkItem:
    """一个可独立执行、验收和重规划的代码工作项。"""

    id: str
    title: str
    objective: str
    acceptance_criteria: list[str] = field(default_factory=list)
    dependencies: list[str] = field(default_factory=list)
    # 数字越小优先级越高；只影响可并行 Work 的启动顺序和资源冲突时的串行顺序。
    priority: int = 100
    # Planner 预估会写入的文件。调度器据此避免同一文件并发写；实际编辑仍有运行时锁兜底。
    target_files: list[str] = field(default_factory=list)
    # 可选串行资源组，例如 database/schema。相同组即使文件不同也按优先级串行。
    serial_group: str = ""
    # filesystem 表示该 Work 可由本地执行器直接完成，不再调用 Worker LLM。
    execution_type: WorkExecutionType = "agent"
    file_operations: list[FileSystemOperation] = field(default_factory=list)
    status: WorkStatus = "pending"
    attempts: int = 0
    summary: str = ""
    error: str = ""
    changed_files: list[str] = field(default_factory=list)
    commands: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        """转换成可发送给 Planner 和前端的稳定 JSON。"""

        return {
            "id": self.id,
            "title": self.title,
            "objective": self.objective,
            "acceptanceCriteria": self.acceptance_criteria,
            "dependencies": self.dependencies,
            "priority": self.priority,
            "targetFiles": self.target_files,
            "serialGroup": self.serial_group,
            "executionType": self.execution_type,
            "fileOperations": [item.to_json() for item in self.file_operations],
            "status": self.status,
            "attempts": self.attempts,
            "summary": self.summary,
            "error": self.error,
            "changedFiles": self.changed_files,
            "commands": self.commands,
        }


class WorkLedger:
    """保存 WorkList 的唯一真实状态，并阻止成功工作被重复执行。"""

    def __init__(self, works: list[WorkItem]) -> None:
        """使用初始工作项创建状态台账。"""

        self._items = {item.id: item for item in works}
        self.revision = 1
        self.reason = "已生成初始 WorkList"

    @property
    def items(self) -> list[WorkItem]:
        """按插入顺序返回工作项。"""

        return list(self._items.values())

    def get(self, work_id: str) -> WorkItem | None:
        """按 ID 查询工作项。"""

        return self._items.get(work_id)

    def _dependencies_satisfied(self, item: WorkItem) -> bool:
        """判断 Work 的所有显式依赖是否已经成功或明确跳过。"""

        completed_ids = {
            candidate.id
            for candidate in self.items
            if candidate.status in {"succeeded", "skipped"}
        }
        return all(dependency in completed_ids for dependency in item.dependencies)

    def ready_items(self) -> list[WorkItem]:
        """返回当前可执行 Work，并按优先级和原始顺序稳定排序。"""

        order = {item.id: index for index, item in enumerate(self.items)}
        ready = [
            item
            for item in self.items
            if item.status in {"pending", "failed"}
            and self._dependencies_satisfied(item)
        ]
        return sorted(ready, key=lambda item: (item.priority, order[item.id]))

    def current_or_next(self, requested_id: str = "") -> WorkItem | None:
        """返回指定可执行 Work，或按优先级返回下一个 Work。"""

        requested = self.get(requested_id) if requested_id else None
        if requested:
            if requested.status == "running":
                return requested
            if (
                requested.status in {"pending", "failed"}
                and self._dependencies_satisfied(requested)
            ):
                return requested
            return None
        return next(iter(self.ready_items()), None)

    def begin(self, work_id: str = "") -> WorkItem:
        """把工作项标记为执行中；已成功工作不允许重新开始。"""

        item = self.current_or_next(work_id)
        if not item:
            raise ValueError("没有可执行的 Work；请完成当前工作或让 Planner 重规划")
        if item.status in {"succeeded", "skipped"}:
            raise ValueError(f"Work {item.id} 已完成，禁止重复执行")
        if item.status != "running":
            item.status = "running"
            item.attempts += 1
            item.error = ""
            self.revision += 1
        return item

    def reset_interrupted_running(self) -> None:
        """恢复 Checkpoint 时把中断中的 Work 放回待办，保留已完成产物。"""

        changed = False
        for item in self.items:
            if item.status == "running":
                item.status = "pending"
                item.error = "上次运行在安全 Checkpoint 之后中断，已等待恢复"
                changed = True
        if changed:
            self.revision += 1
            self.reason = "已恢复中断 Work；成功 Work 不会重复执行"

    def add_artifacts(self, work_id: str, paths: list[str]) -> None:
        """记录某个 Work 实际修改的文件。"""

        item = self.get(work_id)
        if not item:
            return
        for path in paths:
            if path not in item.changed_files:
                item.changed_files.append(path)
        self.revision += 1

    def add_command(self, work_id: str, command: str) -> None:
        """记录某个 Work 执行过的验证命令。"""

        item = self.get(work_id)
        if item and command not in item.commands:
            item.commands.append(command)
            self.revision += 1

    def succeed(self, work_id: str, summary: str) -> None:
        """把工作项标记为成功并清除旧错误。"""

        item = self.get(work_id)
        if not item:
            raise ValueError(f"未知 Work ID：{work_id}")
        item.status = "succeeded"
        item.summary = summary.strip()[:4000] or "工作项已完成"
        item.error = ""
        self.revision += 1
        self.reason = f"{work_id} 已完成"

    def fail(self, work_id: str, error: str) -> None:
        """把工作项标记为失败，等待 Planner 使用完整状态重规划。"""

        item = self.get(work_id)
        if not item:
            raise ValueError(f"未知 Work ID：{work_id}")
        item.status = "failed"
        item.error = error.strip()[:12_000] or "执行失败"
        self.revision += 1
        self.reason = f"{work_id} 执行失败，正在重规划"

    def apply_replan(self, result: Any) -> None:
        """应用重规划，同时保证 succeeded/skipped 工作项不可被回滚。"""

        immutable = {
            item.id for item in self.items if item.status in {"succeeded", "skipped"}
        }
        for replacement in result.retry_items:
            current = self.get(replacement.id)
            if not current or current.id in immutable:
                continue
            current.title = replacement.title or current.title
            current.objective = replacement.objective or current.objective
            current.acceptance_criteria = (
                replacement.acceptance_criteria or current.acceptance_criteria
            )
            current.dependencies = [
                item for item in replacement.dependencies if item not in {current.id}
            ]
            current.priority = replacement.priority
            current.target_files = replacement.target_files or current.target_files
            current.serial_group = replacement.serial_group or current.serial_group
            current.execution_type = replacement.execution_type
            current.file_operations = (
                replacement.file_operations or current.file_operations
            )
            current.status = "pending"
            current.error = ""
        for work_id in result.skipped_ids:
            current = self.get(work_id)
            if current and current.id not in immutable:
                current.status = "skipped"
                current.summary = "Planner 判定该工作已无需继续执行"
                current.error = ""
        for new_item in result.new_items:
            if new_item.id in self._items:
                continue
            self._items[new_item.id] = new_item
        self.revision += 1
        self.reason = result.reason or "Planner 已基于完整 WorkList 重规划"

    def all_finished(self) -> bool:
        """判断所有工作项是否都已成功或明确跳过。"""

        return bool(self._items) and all(
            item.status in {"succeeded", "skipped"} for item in self.items
        )

    def snapshot(self) -> dict[str, Any]:
        """生成包含成功、失败和待办工作项的完整快照。"""

        counts = {
            status: sum(item.status == status for item in self.items)
            for status in ("pending", "running", "succeeded", "failed", "skipped")
        }
        total = len(self._items)
        finished = counts["succeeded"] + counts["skipped"]
        progress = round((finished / max(total, 1)) * 100)
        return {
            "revision": self.revision,
            "reason": self.reason,
            "total": total,
            "pending": counts["pending"],
            "running": counts["running"],
            "succeeded": counts["succeeded"],
            "failed": counts["failed"],
            "skipped": counts["skipped"],
            "overallProgress": progress,
            "items": [item.to_json() for item in self.items],
        }
