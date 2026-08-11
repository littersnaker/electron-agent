"""Work 级别独立上下文数据模型。

每个 Work 维护自己的上下文，不直接读取全局 transcript，避免不同 Work 共享过多
上下文导致 token 爆炸和状态污染。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(slots=True)
class WorkContext:
    """单个 Work 的隔离上下文。

    Worker 只加载当前 Work Context，跨 Work 信息通过 Artifact Memory 传递。
    """

    work_id: str
    objective: str = ""
    relevant_files: list[str] = field(default_factory=list)
    recent_actions: list[str] = field(default_factory=list)
    failure_summary: dict[str, Any] = field(default_factory=dict)
    artifact_refs: list[str] = field(default_factory=list)
    token_usage: dict[str, int] = field(default_factory=dict)

    def add_action(self, action: str) -> None:
        """记录一条最近执行的动作，并控制总量避免无限增长。"""

        self.recent_actions.append(action)
        # 只保留最近 30 条动作摘要，防止 transcript 无限膨胀。
        if len(self.recent_actions) > 30:
            self.recent_actions = self.recent_actions[-30:]

    def add_artifact_ref(self, ref: str) -> None:
        """记录一个 Artifacts 引用。"""

        if ref not in self.artifact_refs:
            self.artifact_refs.append(ref)

    def update_token_usage(self, **kwargs: int) -> None:
        """累加 token 使用量。"""

        for key, value in kwargs.items():
            self.token_usage[key] = self.token_usage.get(key, 0) + value

    def estimate_tokens(self) -> int:
        """估算当前上下文占用 token 数（保守估计）。"""

        total = 0
        total += len(self.objective) // 2
        total += sum(len(f) for f in self.relevant_files) // 4
        total += sum(len(a) for a in self.recent_actions) // 2
        total += sum(len(str(v)) for v in self.failure_summary.values()) // 2
        total += sum(len(r) for r in self.artifact_refs) // 4
        return max(0, total)

    def to_json(self) -> dict[str, Any]:
        """转换成可序列化的 JSON。"""

        return {
            "workId": self.work_id,
            "objective": self.objective,
            "relevantFiles": list(self.relevant_files),
            "recentActions": list(self.recent_actions),
            "failureSummary": dict(self.failure_summary),
            "artifactRefs": list(self.artifact_refs),
            "tokenUsage": dict(self.token_usage),
            "estimatedTokens": self.estimate_tokens(),
        }

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> WorkContext:
        """从 JSON 恢复 WorkContext。"""

        return cls(
            work_id=str(value.get("workId") or ""),
            objective=str(value.get("objective") or ""),
            relevant_files=[str(item) for item in value.get("relevantFiles", [])],
            recent_actions=[str(item) for item in value.get("recentActions", [])],
            failure_summary=dict(value.get("failureSummary", {})),
            artifact_refs=[str(item) for item in value.get("artifactRefs", [])],
            token_usage={
                str(k): int(v) for k, v in dict(value.get("tokenUsage", {})).items()
            },
        )
