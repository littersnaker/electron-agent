"""Patch Intelligence：分析代码修改的直接与间接影响。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from backend.services.quality.risk_engine import RiskAssessment, RiskEngine


@dataclass(slots=True)
class PatchAnalysis:
    """保存 Patch 风险、受影响文件和必须执行的验证。"""

    risk: RiskAssessment
    affected_files: list[str] = field(default_factory=list)
    validation_required: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        """按方案约定输出稳定 JSON。"""

        return {
            "risk": self.risk.level.value,
            "riskScore": self.risk.score,
            "affectedFiles": list(self.affected_files),
            "validationRequired": list(self.validation_required),
            "riskDetails": dict(self.risk.details),
        }


class PatchAnalyzer:
    """结合依赖图、Artifact 依赖和风险引擎分析变更影响。"""

    def __init__(self, risk_engine: RiskEngine | None = None) -> None:
        """允许测试或项目策略注入自定义风险引擎。"""

        self._risk_engine = risk_engine or RiskEngine()

    def analyze(
        self,
        *,
        changed_files: list[str],
        dependency_graph: dict[str, list[str]] | None = None,
        artifact_dependencies: list[str] | None = None,
        test_coverage: float | None = None,
        business_importance: int | None = None,
    ) -> PatchAnalysis:
        """计算受影响文件、依赖深度、风险和验证范围。"""

        normalized = list(dict.fromkeys(path.replace("\\", "/") for path in changed_files))
        affected, depth = self._walk_dependents(normalized, dependency_graph or {})
        risk = self._risk_engine.calculate(
            changed_files=normalized,
            dependency_depth=depth,
            test_coverage=test_coverage,
            business_importance=business_importance,
            artifact_dependencies=artifact_dependencies,
        )
        validations = self._validation_requirements(normalized, risk.level.value)
        return PatchAnalysis(
            risk=risk,
            affected_files=list(dict.fromkeys([*normalized, *affected])),
            validation_required=validations,
        )

    def _walk_dependents(
        self,
        changed_files: list[str],
        graph: dict[str, list[str]],
    ) -> tuple[list[str], int]:
        """沿反向依赖图做有限广度遍历，避免小修改触发全项目扫描。"""

        queue = [(path, 0) for path in changed_files]
        visited = set(changed_files)
        affected: list[str] = []
        max_depth = 0
        while queue and len(visited) < 200:
            current, depth = queue.pop(0)
            for dependent in graph.get(current, []):
                if dependent in visited:
                    continue
                visited.add(dependent)
                affected.append(dependent)
                next_depth = depth + 1
                max_depth = max(max_depth, next_depth)
                if next_depth < 5:
                    queue.append((dependent, next_depth))
        return affected, max_depth

    def _validation_requirements(self, changed_files: list[str], risk: str) -> list[str]:
        """根据语言和风险生成验证类型，而不是硬编码全项目分析。"""

        requirements = ["lint"]
        if any(path.endswith(".py") for path in changed_files):
            requirements.extend(["python-syntax", "unit-test"])
        if any(path.endswith((".ts", ".tsx")) for path in changed_files):
            requirements.extend(["type-check", "frontend-lint"])
        if risk in {"medium", "high"}:
            requirements.append("integration-test")
        if risk == "high":
            requirements.extend(["regression-check", "build"])
        return list(dict.fromkeys(requirements))


__all__ = ["PatchAnalysis", "PatchAnalyzer"]
