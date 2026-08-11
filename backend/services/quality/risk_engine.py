"""统一工程风险评分引擎。

风险由变更文件数量、依赖深度、测试覆盖、业务重要性和 Artifact 依赖共同计算，
最终只暴露 LOW、MEDIUM、HIGH 三档，便于验证引擎选择执行范围。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import PurePosixPath
from typing import Any


class RiskLevel(str, Enum):
    """质量控制层使用的三档风险等级。"""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"


@dataclass(slots=True)
class RiskAssessment:
    """保存风险总分、等级和各评分项。"""

    level: RiskLevel
    score: int
    details: dict[str, int] = field(default_factory=dict)
    business_critical_files: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        """转换为 UI 和 Trace 可直接消费的 JSON。"""

        return {
            "risk": self.level.value,
            "score": self.score,
            "details": dict(self.details),
            "businessCriticalFiles": list(self.business_critical_files),
        }


class RiskEngine:
    """根据可观测工程信号计算 Patch 风险。"""

    _CRITICAL_PARTS = {
        "main.py",
        "router.py",
        "config.py",
        "database.py",
        "contracts.py",
        "schemas",
        "api",
        "runtime",
        "electron",
    }

    def calculate(
        self,
        *,
        changed_files: list[str],
        dependency_depth: int = 0,
        test_coverage: float | None = None,
        business_importance: int | None = None,
        artifact_dependencies: list[str] | None = None,
    ) -> RiskAssessment:
        """计算零到一百分的风险分数并返回三档等级。"""

        normalized = list(dict.fromkeys(path.replace("\\", "/") for path in changed_files))
        critical_files = [path for path in normalized if self._is_critical(path)]
        importance = (
            max(0, min(10, business_importance))
            if business_importance is not None
            else min(10, len(critical_files) * 2)
        )
        coverage = 0.0 if test_coverage is None else max(0.0, min(1.0, test_coverage))
        details = {
            "changedFiles": min(35, len(normalized) * 4),
            "dependencyDepth": min(25, max(0, dependency_depth) * 5),
            "testCoverage": round((1.0 - coverage) * 15),
            "businessImportance": importance * 2,
            "artifactDependency": min(15, len(artifact_dependencies or []) * 3),
        }
        score = min(100, sum(details.values()))
        if score >= 60:
            level = RiskLevel.HIGH
        elif score >= 25:
            level = RiskLevel.MEDIUM
        else:
            level = RiskLevel.LOW
        return RiskAssessment(
            level=level,
            score=score,
            details=details,
            business_critical_files=critical_files,
        )

    def _is_critical(self, path: str) -> bool:
        """根据目录和文件名识别业务关键入口、契约和运行时文件。"""

        parts = {part.lower() for part in PurePosixPath(path).parts}
        return bool(parts.intersection(self._CRITICAL_PARTS))


__all__ = ["RiskAssessment", "RiskEngine", "RiskLevel"]
