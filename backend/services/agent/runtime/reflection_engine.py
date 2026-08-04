"""执行后的轻量反思引擎。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.services.agent.runtime.reasoning_state import ReasoningState


@dataclass(slots=True)
class ReflectionResult:
    """保存一次动作观察后的结论和下一步建议。"""

    success: bool
    issue: str = ""
    next_action: str = ""
    confidence_delta: float = 0.0
    verified_facts: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        """转换为可存入 Checkpoint 的 JSON。"""

        return {
            "success": self.success,
            "issue": self.issue,
            "nextAction": self.next_action,
            "confidenceDelta": self.confidence_delta,
            "verifiedFacts": list(self.verified_facts),
        }


class ReflectionEngine:
    """根据真实工具结果更新推理状态，并决定继续还是修复。"""

    def reflect(
        self,
        *,
        action: str,
        outcome_kind: str,
        summary: str,
        error: str,
        state: ReasoningState,
    ) -> ReflectionResult:
        """对一次 edit、run、factory 或完成动作执行结构化反思。"""

        if outcome_kind == "failure":
            issue = error.strip()[:3_000] or "工具执行失败"
            next_action = "基于失败摘要定位根因，禁止重复同一方案，然后执行最小修复。"
            result = ReflectionResult(
                success=False,
                issue=issue,
                next_action=next_action,
                confidence_delta=-0.2,
            )
            state.add_risk(issue)
        else:
            fact = summary.strip()[:1_000] or f"{action} 动作已获得真实工具结果"
            next_action = self._next_action_for(action, outcome_kind)
            result = ReflectionResult(
                success=True,
                next_action=next_action,
                confidence_delta=0.08 if outcome_kind == "success" else 0.03,
                verified_facts=[fact],
            )
            state.record_decision(
                decision=f"接受 {action} 的真实执行结果",
                reason="后端工具已经返回可观察结果",
                evidence=fact,
            )

        state.set_next_action(
            result.next_action,
            confidence=state.confidence + result.confidence_delta,
        )
        return result

    def _next_action_for(self, action: str, outcome_kind: str) -> str:
        """为成功或继续状态选择一个小步下一动作。"""

        if outcome_kind == "success":
            return "当前 Work 已通过完成条件，等待调度器验收和后续质量检查。"
        if action == "edit":
            return "读取真实 diff 或运行相关验证，确认没有破坏契约。"
        if action == "run":
            return "根据命令结果更新结论；失败则最小修复，成功则完成 Work。"
        if action == "factory":
            return "读取生成产物并完成真实页面接入与一致性验证。"
        return "继续执行当前 Work 的下一个最小步骤。"


__all__ = ["ReflectionEngine", "ReflectionResult"]
