"""Retry 失败摘要化。

失败重试时禁止发送完整失败 transcript，只发送 failure summary、当前代码状态和下一步目标。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class FailureSummary:
    """单次或多次失败的结构化摘要。"""

    error: str = ""
    root_cause: str = ""
    attempts: int = 0
    changed_files: list[str] = field(default_factory=list)
    tried_solutions: list[str] = field(default_factory=list)
    next_recommendation: str = ""

    def add_attempt(self, error: str, solution_tried: str = "") -> None:
        """记录一次重试尝试。"""

        self.attempts += 1
        if error and error not in self.error:
            self.error = error[:4_000]
        if solution_tried and solution_tried not in self.tried_solutions:
            self.tried_solutions.append(solution_tried[:2_000])
            # 只保留最近 10 次尝试的解决方案
            if len(self.tried_solutions) > 10:
                self.tried_solutions = self.tried_solutions[-10:]

    def set_root_cause(self, cause: str) -> None:
        """设置根因分析。"""

        self.root_cause = cause[:4_000]

    def set_next_recommendation(self, recommendation: str) -> None:
        """设置下一步建议。"""

        self.next_recommendation = recommendation[:4_000]

    def add_changed_file(self, path: str) -> None:
        """记录已修改的文件。"""

        if path not in self.changed_files:
            self.changed_files.append(path)

    def to_json(self) -> dict[str, Any]:
        """序列化为 JSON。"""

        return {
            "error": self.error,
            "rootCause": self.root_cause,
            "attempts": self.attempts,
            "changedFiles": list(self.changed_files),
            "triedSolutions": list(self.tried_solutions),
            "nextRecommendation": self.next_recommendation,
        }

    def to_retry_prompt(self) -> str:
        """生成用于 Retry 的精简提示词。

        不携带完整历史，只包含失败摘要、代码状态和下一步目标。
        """

        has_content = bool(
            self.error
            or self.root_cause
            or self.attempts > 0
            or self.changed_files
            or self.tried_solutions
            or self.next_recommendation
        )
        if not has_content:
            return ""

        lines = [
            "## 失败摘要",
            f"错误: {self.error}" if self.error else "",
            f"根因: {self.root_cause}" if self.root_cause else "",
            f"已尝试 {self.attempts} 次" if self.attempts > 0 else "",
        ]

        if self.changed_files:
            lines.append("已修改文件:")
            for path in self.changed_files:
                lines.append(f"  - {path}")

        if self.tried_solutions:
            lines.append("已尝试方案:")
            for solution in self.tried_solutions[-5:]:
                lines.append(f"  - {solution}")

        if self.next_recommendation:
            lines.append(f"建议: {self.next_recommendation}")

        return "\n".join(line for line in lines if line)

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> FailureSummary:
        """从 Checkpoint 宽松恢复失败摘要，兼容旧版本缺失字段。"""

        return cls(
            error=str(value.get("error") or ""),
            root_cause=str(value.get("rootCause") or ""),
            attempts=int(value.get("attempts") or 0),
            changed_files=[str(item) for item in value.get("changedFiles", [])],
            tried_solutions=[str(item) for item in value.get("triedSolutions", [])],
            next_recommendation=str(value.get("nextRecommendation") or ""),
        )

    @classmethod
    def from_error(
        cls,
        error: str,
        *,
        changed_files: list[str] | None = None,
        root_cause: str = "",
    ) -> FailureSummary:
        """从单次错误快速创建摘要。"""

        summary = cls(error=error, root_cause=root_cause)
        if changed_files:
            for path in changed_files:
                summary.add_changed_file(path)
        return summary


class FailureSummaryStore:
    """按 work_id 存储和管理 FailureSummary。"""

    def __init__(self) -> None:
        """初始化空存储。"""

        self._store: dict[str, FailureSummary] = {}

    def get(self, work_id: str) -> FailureSummary:
        """获取指定 Work 的失败摘要，不存在时自动创建。"""

        if work_id not in self._store:
            self._store[work_id] = FailureSummary()
        return self._store[work_id]

    def save(self, work_id: str, summary: FailureSummary) -> None:
        """保存失败摘要。"""

        self._store[work_id] = summary

    def delete(self, work_id: str) -> bool:
        """删除失败摘要。"""

        return bool(self._store.pop(work_id, None))

    def clear(self) -> None:
        """清空全部存储。"""

        self._store.clear()

    def snapshot(self) -> dict[str, dict[str, Any]]:
        """导出全部快照。"""

        return {wid: summary.to_json() for wid, summary in self._store.items()}


__all__ = [
    "FailureSummary",
    "FailureSummaryStore",
]
