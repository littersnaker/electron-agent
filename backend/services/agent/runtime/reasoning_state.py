"""Code Agent 的结构化推理状态模型。

该模型只保存可审计的结论、风险和下一步动作，不保存或要求模型输出冗长的
内部思维过程，从而在低 Token 成本下避免每一轮重复分析历史。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Literal

ReasoningLevel = Literal["simple", "normal", "complex"]


@dataclass(slots=True)
class DecisionRecord:
    """保存一次已经做出的工程决策及其可验证依据。"""

    decision: str
    reason: str
    evidence: str = ""
    timestamp: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def to_json(self) -> dict[str, str]:
        """转换为 Checkpoint 和审计日志可直接保存的 JSON。"""

        return {
            "decision": self.decision,
            "reason": self.reason,
            "evidence": self.evidence,
            "timestamp": self.timestamp,
        }

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "DecisionRecord":
        """从旧 Checkpoint 的宽松 JSON 安全恢复决策记录。"""

        return cls(
            decision=str(value.get("decision") or ""),
            reason=str(value.get("reason") or ""),
            evidence=str(value.get("evidence") or ""),
            timestamp=str(value.get("timestamp") or datetime.now(UTC).isoformat()),
        )


@dataclass(slots=True)
class ReasoningState:
    """保存单个 Work 当前可复用的判断状态。"""

    work_id: str
    objective: str = ""
    current_understanding: str = ""
    hypothesis: str = ""
    decisions: list[DecisionRecord] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)
    next_action: str = ""
    confidence: float = 0.5
    level: ReasoningLevel = "normal"
    token_budget: int = 3_000
    updated_at: str = field(default_factory=lambda: datetime.now(UTC).isoformat())

    def record_decision(self, decision: str, reason: str, evidence: str = "") -> None:
        """追加一条去重决策，并限制历史长度防止状态持续膨胀。"""

        normalized = decision.strip()
        if not normalized:
            return
        if any(item.decision == normalized for item in self.decisions[-20:]):
            return
        self.decisions.append(
            DecisionRecord(
                decision=normalized[:1_000],
                reason=reason.strip()[:2_000],
                evidence=evidence.strip()[:2_000],
            )
        )
        self.decisions = self.decisions[-40:]
        self._touch()

    def add_risk(self, risk: str) -> None:
        """记录一项尚未解除的风险，忽略空值和重复内容。"""

        normalized = risk.strip()
        if normalized and normalized not in self.risks:
            self.risks.append(normalized[:1_000])
            self.risks = self.risks[-20:]
            self._touch()

    def resolve_risk(self, risk: str) -> None:
        """在验证通过后移除已经解除的风险。"""

        self.risks = [item for item in self.risks if item != risk]
        self._touch()

    def set_next_action(self, action: str, *, confidence: float | None = None) -> None:
        """更新下一步动作，并把置信度限制在零到一之间。"""

        self.next_action = action.strip()[:2_000]
        if confidence is not None:
            self.confidence = max(0.0, min(1.0, confidence))
        self._touch()

    def render_summary(self) -> str:
        """生成供下一轮 Worker 使用的紧凑结构化状态摘要。"""

        decisions = "\n".join(
            f"- {item.decision}：{item.reason}" for item in self.decisions[-6:]
        ) or "- 暂无已确认决策"
        risks = "\n".join(f"- {item}" for item in self.risks[-6:]) or "- 暂无已知风险"
        return (
            f"推理级别：{self.level}（预算 {self.token_budget} tokens）\n"
            f"当前理解：{self.current_understanding or '等待读取真实代码'}\n"
            f"工作假设：{self.hypothesis or '尚未形成'}\n"
            f"已确认决策：\n{decisions}\n"
            f"风险：\n{risks}\n"
            f"下一步：{self.next_action or '先读取相关文件'}\n"
            f"置信度：{self.confidence:.2f}"
        )

    def to_json(self) -> dict[str, Any]:
        """转换为可持久化的 Checkpoint JSON。"""

        return {
            "workId": self.work_id,
            "objective": self.objective,
            "currentUnderstanding": self.current_understanding,
            "hypothesis": self.hypothesis,
            "decisions": [item.to_json() for item in self.decisions],
            "risks": list(self.risks),
            "nextAction": self.next_action,
            "confidence": self.confidence,
            "level": self.level,
            "tokenBudget": self.token_budget,
            "updatedAt": self.updated_at,
        }

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> "ReasoningState":
        """从 Checkpoint 恢复推理状态，并兼容缺失的新字段。"""

        raw_level = str(value.get("level") or "normal")
        level: ReasoningLevel = (
            raw_level if raw_level in {"simple", "normal", "complex"} else "normal"
        )  # type: ignore[assignment]
        return cls(
            work_id=str(value.get("workId") or ""),
            objective=str(value.get("objective") or ""),
            current_understanding=str(value.get("currentUnderstanding") or ""),
            hypothesis=str(value.get("hypothesis") or ""),
            decisions=[
                DecisionRecord.from_json(item)
                for item in value.get("decisions", [])
                if isinstance(item, dict)
            ],
            risks=[str(item) for item in value.get("risks", [])],
            next_action=str(value.get("nextAction") or ""),
            confidence=float(value.get("confidence") or 0.5),
            level=level,
            token_budget=int(value.get("tokenBudget") or 3_000),
            updated_at=str(value.get("updatedAt") or datetime.now(UTC).isoformat()),
        )

    def _touch(self) -> None:
        """刷新最近更新时间，便于恢复时判断状态新旧。"""

        self.updated_at = datetime.now(UTC).isoformat()


__all__ = ["DecisionRecord", "ReasoningLevel", "ReasoningState"]
