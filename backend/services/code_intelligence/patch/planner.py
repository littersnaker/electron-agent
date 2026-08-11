"""Patch 规划器。

基于风险评分决定 Patch 执行策略，避免小改动触发全项目重新分析。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.services.code_intelligence.patch.risk_score import PatchRiskAnalyzer, PatchRiskScore

# impact 模块依赖链较重，延迟导入避免初始化失败。
_ImpactAnalyzer: Any = None


def _get_impact_analyzer():
    """延迟加载 ImpactAnalyzer。"""
    global _ImpactAnalyzer
    if _ImpactAnalyzer is None:
        from backend.services.code_intelligence.patch.impact import ImpactAnalyzer
        _ImpactAnalyzer = ImpactAnalyzer
    return _ImpactAnalyzer


@dataclass(slots=True)
class PatchPlan:
    """Patch 执行计划。"""

    can_proceed: bool
    strategy: str
    risk_score: PatchRiskScore | None = None
    impacted_files: list[str] = field(default_factory=list)
    steps: list[dict[str, Any]] = field(default_factory=list)
    reason: str = ""

    def to_json(self) -> dict[str, Any]:
        """序列化为 JSON。"""

        return {
            "canProceed": self.can_proceed,
            "strategy": self.strategy,
            "riskScore": self.risk_score.to_json() if self.risk_score else None,
            "impactedFiles": list(self.impacted_files),
            "steps": list(self.steps),
            "reason": self.reason,
        }


class PatchPlanner:
    """基于风险评分的 Patch 规划器。

    避免小改动触发全项目重新分析，根据风险等级选择执行策略：
    - low: 直接应用
    - medium: 局部影响分析
    - high: 完整影响分析 + 验证
    - critical: 人工确认 + 全量验证
    """

    def __init__(
        self,
        *,
        root: Path | None = None,
        risk_analyzer: PatchRiskAnalyzer | None = None,
        impact_analyzer: Any = None,
    ) -> None:
        """初始化规划器。"""

        self._root = root
        self._risk_analyzer = risk_analyzer or PatchRiskAnalyzer()
        # 延迟加载，避免未安装依赖时初始化失败
        if impact_analyzer is None:
            try:
                impact_analyzer = _get_impact_analyzer()()
            except Exception:  # pragma: no cover
                impact_analyzer = None
        self._impact_analyzer = impact_analyzer

    def plan(
        self,
        *,
        changed_files: list[str],
        dependency_depth: int = 0,
        has_tests: bool = False,
        artifact_dependencies: list[str] | None = None,
    ) -> PatchPlan:
        """制定 Patch 执行计划。"""

        # 1. 风险评估
        risk = self._risk_analyzer.analyze(
            changed_files=changed_files,
            dependency_depth=dependency_depth,
            has_tests=has_tests,
            artifact_dependencies=artifact_dependencies,
            root=self._root,
        )

        # 2. 根据风险等级选择策略
        if risk.risk == "low":
            return self._plan_low_risk(changed_files, risk)

        if risk.risk == "medium":
            return self._plan_medium_risk(changed_files, risk)

        if risk.risk == "high":
            return self._plan_high_risk(changed_files, risk)

        # critical
        return self._plan_critical_risk(changed_files, risk)

    def _plan_low_risk(
        self, changed_files: list[str], risk: PatchRiskScore
    ) -> PatchPlan:
        """低风险：直接应用，不需要全项目分析。"""

        return PatchPlan(
            can_proceed=True,
            strategy="direct_apply",
            risk_score=risk,
            impacted_files=list(changed_files),
            steps=[
                {"action": "apply_patch", "files": changed_files},
                {"action": "verify_syntax", "files": changed_files},
            ],
            reason="低风险变更，可直接应用",
        )

    def _plan_medium_risk(
        self, changed_files: list[str], risk: PatchRiskScore
    ) -> PatchPlan:
        """中风险：局部影响分析。"""

        impacted = []
        if self._root and self._impact_analyzer is not None:
            # 只对直接依赖文件进行分析，不进行全项目扫描
            impacted = self._impact_analyzer.impacted_files(
                self._root, changed_files, limit=20
            )

        return PatchPlan(
            can_proceed=True,
            strategy="local_analysis",
            risk_score=risk,
            impacted_files=list(set(changed_files + impacted)),
            steps=[
                {"action": "apply_patch", "files": changed_files},
                {"action": "check_imports", "files": impacted[:20]},
                {"action": "run_relevant_tests", "files": changed_files + impacted[:10]},
            ],
            reason="中风险变更，需局部影响分析",
        )

    def _plan_high_risk(
        self, changed_files: list[str], risk: PatchRiskScore
    ) -> PatchPlan:
        """高风险：完整影响分析 + 验证。"""

        impacted = []
        if self._root and self._impact_analyzer is not None:
            impacted = self._impact_analyzer.impacted_files(
                self._root, changed_files, limit=50
            )

        steps = [
            {"action": "backup", "files": changed_files},
            {"action": "apply_patch", "files": changed_files},
            {"action": "full_impact_analysis", "files": impacted[:50]},
        ]

        # 添加推荐验证步骤
        for validation in risk.recommended_validation:
            steps.append({"action": "validate", "command": validation})

        return PatchPlan(
            can_proceed=True,
            strategy="full_analysis",
            risk_score=risk,
            impacted_files=list(set(changed_files + impacted)),
            steps=steps,
            reason="高风险变更，需完整影响分析",
        )

    def _plan_critical_risk(
        self, changed_files: list[str], risk: PatchRiskScore
    ) -> PatchPlan:
        """极高风险：建议人工确认。"""

        impacted = []
        if self._root and self._impact_analyzer is not None:
            impacted = self._impact_analyzer.impacted_files(
                self._root, changed_files, limit=100
            )

        return PatchPlan(
            can_proceed=False,  # 建议人工确认
            strategy="manual_review",
            risk_score=risk,
            impacted_files=list(set(changed_files + impacted)),
            steps=[
                {"action": "create_backup"},
                {"action": "notify_review", "reason": "critical_risk"},
                {"action": "run_full_validation"},
            ],
            reason="极高风险变更，建议人工确认后再执行",
        )


__all__ = [
    "PatchPlanner",
    "PatchPlan",
]
