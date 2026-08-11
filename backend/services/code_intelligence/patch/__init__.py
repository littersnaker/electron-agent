"""Code Intelligence Patch 子模块。"""

"""Code Intelligence Patch 子模块。"""

# 新增模块（无外部依赖链，可安全直接导入）
from backend.services.code_intelligence.patch.planner import PatchPlan, PatchPlanner
from backend.services.code_intelligence.patch.risk_score import (
    PatchRiskAnalyzer,
    PatchRiskScore,
    RiskLevel,
)

# impact 模块依赖较重的外部导入链，延迟导入避免初始化失败。
try:
    from backend.services.code_intelligence.patch.impact import ImpactAnalyzer
except Exception:  # pragma: no cover
    ImpactAnalyzer = None  # type: ignore[misc,assignment]

__all__ = [
    "ImpactAnalyzer",
    "PatchPlanner",
    "PatchPlan",
    "PatchRiskAnalyzer",
    "PatchRiskScore",
    "RiskLevel",
]

__all__ = [
    "ImpactAnalyzer",
    "PatchPlanner",
    "PatchPlan",
    "PatchRiskAnalyzer",
    "PatchRiskScore",
    "RiskLevel",
]
