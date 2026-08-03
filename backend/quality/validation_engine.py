"""根据 Patch 风险自动选择并执行验证范围。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from backend.services.agent.command_runner import CommandResult, run_safe_command

CommandRunner = Callable[[Path, str], Awaitable[CommandResult]]


@dataclass(slots=True)
class ValidationCheck:
    """保存一个验证命令及其执行结果。"""

    name: str
    command: str
    required: bool = True
    result: CommandResult | None = None

    def to_json(self) -> dict[str, Any]:
        """转换为前端和质量门可消费的 JSON。"""

        return {
            "name": self.name,
            "command": self.command,
            "required": self.required,
            "executed": self.result is not None,
            "passed": self.result.succeeded if self.result else False,
            "exitCode": self.result.exit_code if self.result else None,
            "timedOut": self.result.timed_out if self.result else False,
            "blockedReason": self.result.blocked_reason if self.result else "",
            "output": self.result.output[-4_000:] if self.result else "",
        }


@dataclass(slots=True)
class ValidationReport:
    """汇总自动选择的验证计划和真实执行状态。"""

    risk: str
    checks: list[ValidationCheck] = field(default_factory=list)
    executed: bool = False

    @property
    def passed(self) -> bool:
        """只有所有必需检查都真实执行并通过时才视为验证成功。"""

        required = [check for check in self.checks if check.required]
        return bool(required) and all(check.result and check.result.succeeded for check in required)

    def to_json(self) -> dict[str, Any]:
        """输出验证命令、执行状态和总结果。"""

        return {
            "risk": self.risk,
            "executed": self.executed,
            "passed": self.passed,
            "checks": [check.to_json() for check in self.checks],
        }


class ValidationEngine:
    """为低、中、高风险 Patch 选择最小、局部或全量验证。"""

    def __init__(self, runner: CommandRunner = run_safe_command) -> None:
        """允许测试注入无副作用命令执行器。"""

        self._runner = runner

    def plan(self, *, root: Path, changed_files: list[str], risk: str) -> ValidationReport:
        """根据项目语言、文件类型和风险创建验证计划。"""

        del root  # 保留参数以便后续读取项目级质量策略文件。
        commands: list[tuple[str, str]] = []
        has_python = any(path.endswith(".py") for path in changed_files)
        has_typescript = any(path.endswith((".ts", ".tsx")) for path in changed_files)

        if has_python:
            commands.append(("Python 语法", "python -m compileall -q backend"))
            if risk in {"medium", "high"}:
                commands.append(("Python 测试", "python -m pytest backend/tests -q"))
        if has_typescript:
            commands.append(("ESLint", "pnpm lint"))
            if risk in {"medium", "high"}:
                commands.append(("TypeScript 类型检查", "pnpm typecheck"))
        if risk in {"medium", "high"}:
            commands.append(("源码规范", "pnpm source:check"))
        if risk == "high" and has_typescript:
            commands.append(("前端生产构建", "pnpm build"))
        if risk == "high" and has_python:
            commands.append(("后端完整测试", "pnpm backend:test"))

        checks = [ValidationCheck(name, command) for name, command in dict(commands).items()]
        return ValidationReport(risk=risk, checks=checks)

    async def execute(
        self,
        *,
        root: Path,
        changed_files: list[str],
        risk: str,
    ) -> ValidationReport:
        """顺序执行验证计划，并在任一必需检查失败后保留完整报告。"""

        report = self.plan(root=root, changed_files=changed_files, risk=risk)
        report.executed = True
        for check in report.checks:
            check.result = await self._runner(root, check.command)
        return report

    def from_existing_results(
        self,
        *,
        risk: str,
        results: list[CommandResult],
    ) -> ValidationReport:
        """把 Worker 已经执行的质量命令转换为统一验证报告。"""

        checks = [
            ValidationCheck(name=result.command, command=result.command, result=result)
            for result in results
        ]
        return ValidationReport(risk=risk, checks=checks, executed=bool(checks))


__all__ = ["ValidationCheck", "ValidationEngine", "ValidationReport"]
