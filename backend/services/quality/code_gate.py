"""提交前 Code Quality Gate。"""

from __future__ import annotations

import ast
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from backend.quality.regression_detector import RegressionReport
from backend.quality.risk_engine import RiskAssessment, RiskLevel
from backend.quality.validation_engine import ValidationReport
from backend.services.workspace.indexer import iter_project_files


@dataclass(slots=True)
class CodeGateReport:
    """保存质量门是否通过以及阻断项和提醒项。"""

    passed: bool
    issues: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    checked_files: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        """转换为 UI 和最终报告可展示的 JSON。"""

        return {
            "passed": self.passed,
            "issues": list(self.issues),
            "warnings": list(self.warnings),
            "checkedFiles": list(self.checked_files),
        }


class CodeGate:
    """在提交前检查项目规范、测试、未使用代码信号和引入风险。"""

    def evaluate(
        self,
        *,
        root: Path,
        changed_files: list[str],
        risk: RiskAssessment,
        validation: ValidationReport,
        regression: RegressionReport,
    ) -> CodeGateReport:
        """执行静态规范检查并合并验证、回归和风险结论。"""

        issues: list[str] = []
        warnings: list[str] = []
        checked: list[str] = []
        for relative in list(dict.fromkeys(changed_files)):
            path = root / relative
            if not path.is_file() or path.suffix not in {".py", ".ts", ".tsx", ".js", ".jsx"}:
                continue
            checked.append(relative)
            line_count = len(path.read_text("utf-8", errors="replace").splitlines())
            if line_count > 500:
                issues.append(f"{relative} 有 {line_count} 行，超过 500 行限制")
            if path.suffix == ".py":
                issues.extend(self._python_docstring_issues(path, relative))

        if validation.executed and not validation.passed:
            issues.append("自动验证未全部通过")
        if not validation.executed:
            warnings.append("当前模式未执行自动验证，交付前仍需运行建议命令")
        if regression.regression:
            issues.extend(regression.issues)
        elif regression.api_contract_changed:
            warnings.append("公共 API 契约发生变化，但现有验证未发现功能回归")
        if risk.level is RiskLevel.HIGH and not validation.passed:
            issues.append("高风险修改必须通过完整验证")
        if not self._has_related_tests(root, changed_files):
            warnings.append("未发现与本次修改直接对应的新测试文件")
        if self._contains_unused_signal(validation):
            issues.append("Lint 输出包含未使用代码或未使用变量错误")
        return CodeGateReport(
            passed=not issues,
            issues=list(dict.fromkeys(issues)),
            warnings=list(dict.fromkeys(warnings)),
            checked_files=checked,
        )

    def _python_docstring_issues(self, path: Path, relative: str) -> list[str]:
        """检查修改后的 Python 函数和方法是否具有中文可维护注释。"""

        try:
            tree = ast.parse(path.read_text("utf-8"), filename=relative)
        except SyntaxError as exc:
            return [f"{relative}:{exc.lineno} Python 语法错误：{exc.msg}"]
        issues = []
        for node in ast.walk(tree):
            if (
                isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                and ast.get_docstring(node) is None
            ):
                issues.append(f"{relative}:{node.lineno} 函数 {node.name} 缺少 docstring")
        return issues

    def _has_related_tests(self, root: Path, changed_files: list[str]) -> bool:
        """通过文件名和常见测试目录判断是否存在相关测试覆盖。"""

        changed_names = {Path(path).stem.removeprefix("test_") for path in changed_files}
        for relative in iter_project_files(root):
            if not Path(relative).name.startswith("test_") or not relative.endswith(".py"):
                continue
            if Path(relative).stem.removeprefix("test_") in changed_names:
                return True
        return any("test" in Path(path).parts for path in changed_files)

    def _contains_unused_signal(self, validation: ValidationReport) -> bool:
        """从 Lint 输出识别 Python F401 和 TypeScript 未使用变量错误。"""

        markers = ("F401", "no-unused-vars", "is defined but never used", "未使用")
        for check in validation.checks:
            output = check.result.output if check.result else ""
            if any(marker.lower() in output.lower() for marker in markers):
                return True
        return False


__all__ = ["CodeGate", "CodeGateReport"]
