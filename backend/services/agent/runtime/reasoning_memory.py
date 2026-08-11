"""保存关键决策、放弃方案和已验证事实的 Work 级推理记忆。"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

MemoryCategory = Literal["decision", "abandoned", "verified"]


@dataclass(slots=True)
class ReasoningMemoryEntry:
    """一条可审计且可在 Retry 时复用的推理记忆。"""

    decision: str
    reason: str
    evidence: str
    category: MemoryCategory = "decision"
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_json(self) -> dict[str, str]:
        """转换为稳定 JSON 字段。"""

        return {
            "decision": self.decision,
            "reason": self.reason,
            "evidence": self.evidence,
            "category": self.category,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> ReasoningMemoryEntry:
        """从 Checkpoint 宽松恢复一条记忆。"""

        raw_category = str(value.get("category") or "decision")
        category: MemoryCategory = (
            raw_category
            if raw_category in {"decision", "abandoned", "verified"}
            else "decision"
        )  # type: ignore[assignment]
        return cls(
            decision=str(value.get("decision") or ""),
            reason=str(value.get("reason") or ""),
            evidence=str(value.get("evidence") or ""),
            category=category,
            timestamp=str(value.get("timestamp") or datetime.now(UTC).isoformat()),
        )


class ReasoningMemory:
    """管理单个 Work 的有限推理记忆，防止重复分析历史。"""

    def __init__(self, entries: list[ReasoningMemoryEntry] | None = None) -> None:
        """使用已有条目创建记忆，并限制恢复数据的最大长度。"""

        self._entries = list(entries or [])[-60:]

    def add(
        self,
        *,
        decision: str,
        reason: str,
        evidence: str = "",
        category: MemoryCategory = "decision",
    ) -> None:
        """追加一条非重复记忆，并保留最近六十条。"""

        normalized = decision.strip()
        if not normalized:
            return
        if any(item.decision == normalized and item.category == category for item in self._entries):
            return
        self._entries.append(
            ReasoningMemoryEntry(
                decision=normalized[:1_000],
                reason=reason.strip()[:2_000],
                evidence=evidence.strip()[:2_000],
                category=category,
            )
        )
        self._entries = self._entries[-60:]

    def render_recent(self, limit: int = 8) -> str:
        """生成 Retry 可复用的最近记忆摘要。"""

        selected = self._entries[-max(1, limit) :]
        return "\n".join(
            f"- [{item.category}] {item.decision}；依据：{item.evidence or item.reason}"
            for item in selected
        )

    def to_json(self) -> list[dict[str, str]]:
        """导出全部记忆条目。"""

        return [item.to_json() for item in self._entries]

    @classmethod
    def from_json(cls, value: list[dict[str, Any]]) -> ReasoningMemory:
        """从 Checkpoint 数组恢复记忆。"""

        return cls(
            [
                ReasoningMemoryEntry.from_json(item)
                for item in value
                if isinstance(item, dict)
            ]
        )


__all__ = ["MemoryCategory", "ReasoningMemory", "ReasoningMemoryEntry"]
