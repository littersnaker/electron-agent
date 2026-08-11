"""Code Agent 受限终端命令执行器。

该模块不是操作系统级沙箱。它只在用户明确选择“全自动”时运行，并通过无 shell、
工作区 cwd、命令白名单、超时和输出上限降低风险。
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


MAX_COMMAND_OUTPUT_CHARS = 80_000
DEFAULT_TIMEOUT_SECONDS = 180
SHELL_META_PATTERN = re.compile(r"[;&|><`\r\n]")


def _load_extra_whitelist() -> tuple[set[str], set[str]]:
    """从用户配置追加命令白名单；默认配置为空数组，追加不会收窄安全基线。"""

    try:
        raw = json.loads(
            (
                Path(__file__).resolve().parents[3]
                / "config"
                / "command-whitelist.json"
            ).read_text("utf-8")
        )
    except (OSError, ValueError):
        raw = {}
    if not isinstance(raw, dict):
        return set(), set()
    executables = raw.get("allowedDirectExecutables") or []
    scripts = raw.get("allowedPackageScripts") or []
    return (
        {str(item) for item in executables if isinstance(item, str)},
        {str(item) for item in scripts if isinstance(item, str)},
    )


_EXTRA_EXECUTABLES, _EXTRA_PACKAGE_SCRIPTS = _load_extra_whitelist()
ALLOWED_DIRECT_EXECUTABLES = {
    "pytest",
    "ruff",
    "eslint",
    "tsc",
    "vitest",
    "jest",
} | _EXTRA_EXECUTABLES
ALLOWED_PACKAGE_SCRIPTS = {
    "test",
    "lint",
    "build",
    "typecheck",
    "check",
    "verify",
    "format:check",
    "source:check",
    "planning:test",
    "backend:test",
    "backend:check",
    "electron:typecheck",
} | _EXTRA_PACKAGE_SCRIPTS


@dataclass(slots=True)
class CommandResult:
    """一次本地命令的可审计结果。"""

    command: str
    exit_code: int
    output: str
    timed_out: bool = False
    blocked_reason: str = ""

    @property
    def succeeded(self) -> bool:
        """判断命令是否成功完成。"""

        return not self.blocked_reason and not self.timed_out and self.exit_code == 0


def _split_command(command: str) -> list[str]:
    """在不启用 shell 的前提下解析命令参数。"""

    if SHELL_META_PATTERN.search(command):
        raise ValueError("命令包含管道、重定向或 shell 控制符，已阻止执行")
    parts = shlex.split(command, posix=os.name != "nt")
    if not parts:
        raise ValueError("命令不能为空")
    if os.name == "nt":
        parts = [item[1:-1] if len(item) >= 2 and item[0] == item[-1] == "\"" else item for item in parts]
    return parts


def _normalize_executable(value: str) -> str:
    """提取命令可执行文件名并去掉 Windows 扩展名。"""

    name = Path(value.strip('"')).name.lower()
    return name[:-4] if name.endswith(".exe") else name


def _validate_package_command(executable: str, args: list[str]) -> str | None:
    """只允许包管理器运行已有的质量检查脚本。"""

    if not args:
        return "包管理器命令缺少脚本名"
    normalized = [item.lower() for item in args]
    if normalized[0] == "run" and len(normalized) >= 2:
        script = normalized[1]
    else:
        script = normalized[0]
    if script not in ALLOWED_PACKAGE_SCRIPTS:
        return f"{executable} 只允许执行测试、lint、build、typecheck 等已批准脚本"
    return None


def validate_command(command: str, root: Path) -> tuple[list[str], str | None]:
    """校验全自动模式允许执行的命令。"""

    del root  # 当前仅用于保持接口语义，后续可读取项目级策略文件。
    try:
        parts = _split_command(command)
    except ValueError as exc:
        return [], str(exc)
    executable = _normalize_executable(parts[0])
    args = parts[1:]

    if executable in {"pnpm", "npm", "yarn", "bun"}:
        return parts, _validate_package_command(executable, args)
    if executable in ALLOWED_DIRECT_EXECUTABLES:
        return parts, None
    if executable in {"python", "python3", "py"}:
        lowered = [item.lower() for item in args]
        allowed_module = (
            len(lowered) >= 2
            and lowered[0] == "-m"
            and lowered[1] in {"pytest", "unittest", "compileall"}
        )
        if allowed_module:
            return parts, None
        return parts, "Python 全自动模式只允许 pytest、unittest 或 compileall"
    if executable == "npx":
        if args and args[0].lower() in {"tsc", "eslint", "prettier", "vitest", "jest"}:
            return parts, None
        return parts, "npx 只允许 tsc、eslint、prettier、vitest 或 jest"
    if executable == "git":
        if args and args[0].lower() in {"status", "diff"}:
            return parts, None
        return parts, "全自动模式中的 git 只允许 status 和 diff"
    if executable == "cargo":
        if args and args[0].lower() in {"test", "check", "clippy"}:
            return parts, None
        return parts, "cargo 只允许 test、check 或 clippy"
    if executable == "go":
        if args and args[0].lower() in {"test", "vet"}:
            return parts, None
        return parts, "go 只允许 test 或 vet"
    if executable == "dotnet":
        if args and args[0].lower() in {"test", "build"}:
            return parts, None
        return parts, "dotnet 只允许 test 或 build"
    return parts, f"未批准的可执行文件：{executable}"


async def run_safe_command(
    root: Path,
    command: str,
    *,
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS,
) -> CommandResult:
    """在项目根目录执行白名单命令并收集有限输出。"""

    parts, blocked_reason = validate_command(command, root)
    if blocked_reason:
        return CommandResult(command, -1, "", blocked_reason=blocked_reason)

    environment = os.environ.copy()
    environment.update({"CI": "1", "NO_COLOR": "1", "PYTHONUTF8": "1"})
    creationflags = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0
    executable = shutil.which(parts[0])
    if not executable:
        return CommandResult(command, -1, f"找不到命令：{parts[0]}")
    try:
        process = await asyncio.create_subprocess_exec(
            executable,
            *parts[1:],
            cwd=str(root),
            env=environment,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            creationflags=creationflags,
        )
    except OSError as exc:
        return CommandResult(command, -1, f"命令启动失败：{exc}")
    try:
        output_bytes, _ = await asyncio.wait_for(
            process.communicate(), timeout=max(10, min(timeout_seconds, 600))
        )
        output = output_bytes.decode("utf-8", errors="replace")
        if len(output) > MAX_COMMAND_OUTPUT_CHARS:
            output = f"{output[-MAX_COMMAND_OUTPUT_CHARS:]}\n（仅保留最后部分输出）"
        return CommandResult(command, int(process.returncode or 0), output)
    except TimeoutError:
        process.kill()
        output_bytes, _ = await process.communicate()
        output = output_bytes.decode("utf-8", errors="replace")[-MAX_COMMAND_OUTPUT_CHARS:]
        return CommandResult(command, -1, output, timed_out=True)
