"""检测功能验证失败、公共 API 契约变化和 Artifact 失效。"""

from __future__ import annotations

import ast
import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.services.quality.validation_engine import ValidationReport

_EXPORT_PATTERN = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:async\s+)?"
    r"(?:function|class|interface|type|const|let|var)\s+"
    r"([A-Za-z_$][\w$]*)",
    re.MULTILINE,
)


@dataclass(slots=True)
class ContractSnapshot:
    """保存修改前公共符号签名和 Artifact 文件哈希。"""

    signatures: dict[str, str] = field(default_factory=dict)
    artifact_hashes: dict[str, str] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        """转换为 Checkpoint 可保存的 JSON。"""

        return {
            "signatures": dict(self.signatures),
            "artifactHashes": dict(self.artifact_hashes),
        }

    @classmethod
    def from_json(cls, value: dict[str, Any]) -> ContractSnapshot:
        """从 Checkpoint 恢复修改前快照。"""

        return cls(
            signatures={str(k): str(v) for k, v in dict(value.get("signatures") or {}).items()},
            artifact_hashes={
                str(k): str(v) for k, v in dict(value.get("artifactHashes") or {}).items()
            },
        )


@dataclass(slots=True)
class RegressionReport:
    """保存回归检测结论和需要人工关注的契约变化。"""

    regression: bool
    functional_failure: bool = False
    api_contract_changed: bool = False
    changed_contracts: list[str] = field(default_factory=list)
    invalid_artifacts: list[str] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        """转换为 UI 质量指标 JSON。"""

        return {
            "regression": self.regression,
            "functionalFailure": self.functional_failure,
            "apiContractChanged": self.api_contract_changed,
            "changedContracts": list(self.changed_contracts),
            "invalidArtifacts": list(self.invalid_artifacts),
            "issues": list(self.issues),
        }


class RegressionDetector:
    """在修改前后比较公共契约，并结合验证结果判断真实回归。"""

    def capture(self, root: Path, paths: list[str]) -> ContractSnapshot:
        """读取修改前文件并保存公共符号签名和 Artifact 哈希。"""

        snapshot = ContractSnapshot()
        for relative in paths:
            path = (root / relative).resolve()
            if not path.is_file() or not path.is_relative_to(root.resolve()):
                continue
            content = path.read_text("utf-8", errors="replace")
            signature = self._contract_signature(path, content)
            if signature:
                snapshot.signatures[relative] = signature
            if self._is_artifact(path):
                snapshot.artifact_hashes[relative] = self._hash(content)
        return snapshot

    def detect(
        self,
        *,
        root: Path,
        baseline: ContractSnapshot,
        validation: ValidationReport,
        artifact_dependencies: list[str] | None = None,
    ) -> RegressionReport:
        """检测验证失败、公共契约变化和依赖 Artifact 缺失。"""

        changed_contracts: list[str] = []
        for relative, old_signature in baseline.signatures.items():
            path = root / relative
            if not path.is_file():
                changed_contracts.append(relative)
                continue
            content = path.read_text("utf-8", errors="replace")
            if self._contract_signature(path, content) != old_signature:
                changed_contracts.append(relative)

        invalid_artifacts = [
            relative
            for relative in artifact_dependencies or []
            if not (root / relative).is_file()
        ]
        functional_failure = validation.executed and not validation.passed
        issues: list[str] = []
        if functional_failure:
            issues.append("至少一个必需验证未通过，原功能可能已被破坏")
        if changed_contracts:
            issues.append("检测到公共 API 或导出契约变化，需要确认兼容性")
        if invalid_artifacts:
            issues.append("存在缺失的 Artifact 依赖")
        regression = functional_failure or bool(invalid_artifacts)
        return RegressionReport(
            regression=regression,
            functional_failure=functional_failure,
            api_contract_changed=bool(changed_contracts),
            changed_contracts=changed_contracts,
            invalid_artifacts=invalid_artifacts,
            issues=issues,
        )

    def _contract_signature(self, path: Path, content: str) -> str:
        """提取 Python 公共定义或 TypeScript 导出名称并计算稳定签名。"""

        if path.suffix == ".py":
            try:
                tree = ast.parse(content)
            except SyntaxError:
                return "syntax-error"
            public = []
            for node in tree.body:
                if (
                    isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                    and not node.name.startswith("_")
                ):
                    public.append(f"fn:{node.name}:{len(node.args.args)}")
                elif isinstance(node, ast.ClassDef) and not node.name.startswith("_"):
                    public.append(f"class:{node.name}")
            return self._hash("\n".join(public)) if public else ""
        if path.suffix in {".ts", ".tsx"}:
            exports = sorted(_EXPORT_PATTERN.findall(content))
            return self._hash("\n".join(exports)) if exports else ""
        return ""

    def _is_artifact(self, path: Path) -> bool:
        """识别常见结构化产物和模板文件。"""

        return path.suffix.lower() in {".json", ".yaml", ".yml", ".html", ".md"}

    def _hash(self, value: str) -> str:
        """计算用于比较而非安全认证的短 SHA-256 哈希。"""

        return hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]


__all__ = ["ContractSnapshot", "RegressionDetector", "RegressionReport"]
