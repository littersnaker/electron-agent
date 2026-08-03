"""Patch 风险评估评分。

计算：risk = changed_files + dependency_depth + test_coverage + artifact_dependency
避免小改动触发全项目重新分析。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class RiskLevel(str, Enum):
    """风险等级。"""

    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass(slots=True)
class PatchRiskScore:
    """Patch 影响风险评分结果。"""

    risk: str
    score: int
    changed_files: list[str] = field(default_factory=list)
    affected_files: list[str] = field(default_factory=list)
    recommended_validation: list[str] = field(default_factory=list)
    details: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        """序列化为 JSON。"""

        return {
            "risk": self.risk,
            "score": self.score,
            "changedFiles": list(self.changed_files),
            "affectedFiles": list(self.affected_files),
            "recommendedValidation": list(self.recommended_validation),
            "details": dict(self.details),
        }


class PatchRiskAnalyzer:
    """分析 Patch 变更的风险等级，避免全项目重新分析。"""

    # 风险阈值
    LOW_THRESHOLD = 20
    MEDIUM_THRESHOLD = 50
    HIGH_THRESHOLD = 100

    # 权重配置
    WEIGHTS = {
        "changed_files": 5,  # 每变更一个文件
        "dependency_depth": 10,  # 依赖深度
        "test_coverage": -8,  # 有测试覆盖可减分
        "artifact_dependency": 7,  # artifact 依赖
        "core_file": 15,  # 核心文件变更
        "public_api": 12,  # 公共 API 变更
    }

    # 核心文件模式
    CORE_PATTERNS = [
        "main.py",
        "index.py",
        "__init__.py",
        "router.py",
        "config.py",
        "models.py",
        "schema.py",
    ]

    def __init__(self, weights: dict[str, int] | None = None) -> None:
        """初始化分析器，可传入自定义权重。"""

        self._weights = {**self.WEIGHTS, **(weights or {})}

    def analyze(
        self,
        *,
        changed_files: list[str],
        dependency_depth: int = 0,
        has_tests: bool = False,
        artifact_dependencies: list[str] | None = None,
        root: Path | None = None,
    ) -> PatchRiskScore:
        """分析 Patch 风险。

        参数:
            changed_files: 变更文件列表
            dependency_depth: 依赖链最大深度
            has_tests: 是否有测试覆盖
            artifact_dependencies: 依赖的 artifact 列表
            root: 项目根目录（用于检测核心文件）
        """

        score = 0
        details: dict[str, int] = {}

        # 1. 变更文件数量
        file_score = len(changed_files) * self._weights["changed_files"]
        details["changed_files"] = file_score
        score += file_score

        # 2. 依赖深度
        depth_score = dependency_depth * self._weights["dependency_depth"]
        details["dependency_depth"] = depth_score
        score += depth_score

        # 3. 测试覆盖（减分）
        if has_tests:
            test_score = self._weights["test_coverage"]
            details["test_coverage"] = test_score
            score += test_score

        # 4. Artifact 依赖
        artifact_deps = artifact_dependencies or []
        artifact_score = len(artifact_deps) * self._weights["artifact_dependency"]
        details["artifact_dependency"] = artifact_score
        score += artifact_score

        # 5. 核心文件检测
        core_files = self._detect_core_files(changed_files)
        core_score = len(core_files) * self._weights["core_file"]
        details["core_file"] = core_score
        score += core_score

        # 6. 公共 API 变更检测（基于文件命名约定）
        public_api_files = self._detect_public_api(changed_files)
        api_score = len(public_api_files) * self._weights["public_api"]
        details["public_api"] = api_score
        score += api_score

        # 确定风险等级
        risk = self._score_to_risk(score)

        # 生成推荐的验证命令
        validations = self._recommend_validation(
            changed_files=changed_files,
            has_tests=has_tests,
            core_files=core_files,
        )

        return PatchRiskScore(
            risk=risk,
            score=score,
            changed_files=list(changed_files),
            affected_files=[],  # 由调用方填充
            recommended_validation=validations,
            details=details,
        )

    def _detect_core_files(self, changed_files: list[str]) -> list[str]:
        """检测变更中是否包含核心文件。"""

        return [
            path
            for path in changed_files
            if any(path.endswith(pattern) for pattern in self.CORE_PATTERNS)
        ]

    def _detect_public_api(self, changed_files: list[str]) -> list[str]:
        """检测公共 API 文件变更。"""

        api_patterns = [
            "api/",
            "router",
            "endpoint",
            "handler",
            "service.py",
            "controller",
        ]
        return [
            path
            for path in changed_files
            if any(pattern in path.lower() for pattern in api_patterns)
        ]

    def _score_to_risk(self, score: int) -> str:
        """将分数转换为风险等级。"""

        if score >= self.HIGH_THRESHOLD:
            return RiskLevel.CRITICAL.value
        if score >= self.MEDIUM_THRESHOLD:
            return RiskLevel.HIGH.value
        if score >= self.LOW_THRESHOLD:
            return RiskLevel.MEDIUM.value
        return RiskLevel.LOW.value

    def _recommend_validation(
        self,
        *,
        changed_files: list[str],
        has_tests: bool,
        core_files: list[str],
    ) -> list[str]:
        """根据变更内容推荐验证命令。"""

        validations = []

        # Python 项目
        py_files = [f for f in changed_files if f.endswith(".py")]
        if py_files:
            validations.append("python -m pytest")
            validations.append("python -m mypy .")
            validations.append("python -m ruff check .")

        # TypeScript 项目
        ts_files = [f for f in changed_files if f.endswith((".ts", ".tsx"))]
        if ts_files:
            validations.append("npx tsc --noEmit")
            validations.append("npx eslint .")

        # 核心文件变更需要额外验证
        if core_files:
            validations.append("运行全量测试套件")
            validations.append("验证启动流程")

        if not has_tests:
            validations.append("建议补充测试用例")

        return validations

    def quick_check(self, changed_files: list[str]) -> str:
        """快速检查，只返回风险等级字符串。"""

        result = self.analyze(changed_files=changed_files)
        return result.risk


__all__ = [
    "PatchRiskAnalyzer",
    "PatchRiskScore",
    "RiskLevel",
]
