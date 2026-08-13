"""Code Agent 受限终端命令执行器。

该模块不是操作系统级沙箱。它只在用户明确选择“全自动”时运行，并通过无 shell、
工作区 cwd、命令白名单、超时和输出上限降低风险。
沙箱 A 层加固：命令子进程只继承白名单环境变量（不携带任何 API Key/宿主密钥），
并识别“会执行工作区代码或配置”的高危命令（配置劫持风险）。
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

# 命令子进程允许继承的环境变量白名单：只保留运行工具必需的基础变量，
# 不包含任何 API Key / 密钥。即使工作区代码被执行（配置劫持），也拿不到宿主密钥。
ALLOWED_ENV_VARIABLES = (
    "PATH",
    "HOME",
    "USERPROFILE",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_MESSAGES",
    "TERM",
    "TZ",
    "COMSPEC",
    "PATHEXT",
    "PROCESSOR_ARCHITECTURE",
    "NUMBER_OF_PROCESSORS",
    "OS",
    "CI",
    "NO_COLOR",
    "PYTHONUTF8",
    "PYTHONUNBUFFERED",
    "VIRTUAL_ENV",
    "USER",
    "SHELL",
    "ProgramFiles",
    "ProgramFiles(x86)",
    "ProgramData",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "npm_config_userconfig",
    "npm_config_cache",
)


def _sandboxed_environment() -> dict[str, str]:
    """构造命令子进程的最小环境：只继承白名单变量，丢弃所有密钥。

    Windows 环境变量名大小写不敏感（实际可能只有 SYSTEMROOT 而没有
    SystemRoot），按大写键匹配实际存在的变量再回填白名单键名，
    避免关键系统变量（SystemRoot）被精确匹配丢掉导致子进程初始化失败。
    """

    source = os.environ.copy()
    lookup = {key.upper(): key for key in source}
    result: dict[str, str] = {}
    for allowed in ALLOWED_ENV_VARIABLES:
        actual = lookup.get(allowed.upper())
        if actual is not None:
            result[allowed] = source[actual]
    result.update({"CI": "1", "NO_COLOR": "1", "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"})
    return result


def _load_extra_whitelist() -> tuple[set[str], set[str]]:
    """从用户配置追加命令白名单；默认配置为空数组，追加不会收窄安全基线。"""

    try:
        raw = json.loads(
            (
                Path(__file__).resolve().parents[4]
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

# 需要用户确认后才能执行的包管理器子命令（安装/初始化/脚手架等）。
_INSTALL_SUBCOMMANDS = {
    "install",
    "add",
    "i",
    "remove",
    "rm",
    "uninstall",
    "update",
    "create",
    "init",
    "ci",
    "dlx",
}


def command_approval_enabled() -> bool:
    """命令审批门默认开启；显式设 CODE_AGENT_COMMAND_APPROVAL=0 可关闭。"""

    return os.getenv("CODE_AGENT_COMMAND_APPROVAL", "1").strip() != "0"


def requires_user_approval(command: str) -> bool:
    """判断命令是否属于安装/初始化/脚手架类，需要用户确认后才放行。"""

    try:
        parts = _split_command(command)
    except ValueError:
        return False
    if not parts:
        return False
    executable = _normalize_executable(parts[0])
    args = [item.lower() for item in parts[1:]]
    if executable in {"pnpm", "npm", "yarn", "bun"}:
        return bool(args and args[0] in _INSTALL_SUBCOMMANDS)
    if executable == "npx":
        # npx 只放行白名单质量工具；其余（脚手架/初始化）需要用户确认。
        return not (args and args[0] in {"tsc", "eslint", "prettier", "vitest", "jest"})
    if executable in {"pip", "pip3", "python", "python3", "py"}:
        if executable in {"pip", "pip3"}:
            return bool(args and args[0] == "install")
        return (
            len(args) >= 3
            and args[0] == "-m"
            and args[1] in {"pip", "pip3"}
            and args[2] == "install"
        )
    return False


def _install_package_whitelist() -> frozenset[str]:
    """读取安装包白名单（逗号分隔，小写）；空表示不限制。"""

    raw = os.getenv("CODE_AGENT_INSTALL_PACKAGE_WHITELIST", "").strip()
    return frozenset(name.strip().lower() for name in raw.split(",") if name.strip())


def install_packages_allowed(command: str) -> bool:
    """校验安装命令中的包名是否全部在白名单内；白名单为空时直接放行。"""

    whitelist = _install_package_whitelist()
    if not whitelist:
        return True
    try:
        parts = _split_command(command)
    except ValueError:
        return False
    if not parts:
        return False
    executable = _normalize_executable(parts[0])
    args = [item.lower() for item in parts[1:]]
    packages: list[str] = []
    if executable in {"pnpm", "npm", "yarn", "bun"}:
        if not args or args[0] not in {"install", "i", "add"}:
            return True
        packages = [item for item in args[1:] if not item.startswith("-")]
    elif executable in {"pip", "pip3"}:
        packages = [item for item in args[1:] if not item.startswith("-")]
    elif executable in {"python", "python3", "py"}:
        if (
            len(args) >= 3
            and args[0] == "-m"
            and args[1] in {"pip", "pip3"}
        ):
            packages = [item for item in args[2:] if not item.startswith("-")]
    return all(package in whitelist for package in packages)


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


def is_high_risk_command(command: str) -> bool:
    """判断命令是否属于安装/初始化/脚手架类，需要人工确认后执行。

    白名单验证命令（build/typecheck/lint/test 等）是 Agent 验证改动的必经之路，
    即使它们会执行项目代码也必须放行——否则 Agent 无法验证自己的产物（此前
    一刀切把 pytest/tsc/build 全判高危，导致验证环节完全瘫痪）。真正需要拦截的
    是改变项目依赖或工程结构的命令（install/add/create/init 等），它们需用户确认。
    与 requires_user_approval 判定一致，供 worker 路径（拦截提示）与 review
    路径（跳过标注）共用。
    """

    return requires_user_approval(command)


def validate_command(
    command: str,
    root: Path,
    *,
    approved: bool = False,
) -> tuple[list[str], str | None]:
    """校验全自动模式允许执行的命令；approved 表示该命令已通过用户审批。"""

    del root  # 当前仅用于保持接口语义，后续可读取项目级策略文件。
    try:
        parts = _split_command(command)
    except ValueError as exc:
        return [], str(exc)
    executable = _normalize_executable(parts[0])
    args = parts[1:]

    if executable in {"pnpm", "npm", "yarn", "bun"}:
        if requires_user_approval(command):
            if approved:
                if install_packages_allowed(command):
                    return parts, None
                return parts, "安装的包不在 CODE_AGENT_INSTALL_PACKAGE_WHITELIST 白名单内"
            return parts, "该命令属于安装/初始化/脚手架类，需要用户确认后才能执行"
        return parts, _validate_package_command(executable, args)
    if executable in ALLOWED_DIRECT_EXECUTABLES:
        return parts, None
    if executable in {"python", "python3", "py"}:
        if requires_user_approval(command):
            if approved:
                if install_packages_allowed(command):
                    return parts, None
                return parts, "安装的包不在 CODE_AGENT_INSTALL_PACKAGE_WHITELIST 白名单内"
            return parts, "该 Python 安装命令需要用户确认后才能执行"
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
        if requires_user_approval(command):
            if approved:
                return parts, None
            return parts, "该 npx 命令属于脚手架/初始化类，需要用户确认后才能执行"
        if args and args[0].lower() in {"tsc", "eslint", "prettier", "vitest", "jest"}:
            return parts, None
        return parts, "npx 只允许 tsc、eslint、prettier、vitest 或 jest"
    if executable in {"pip", "pip3"}:
        if requires_user_approval(command):
            if approved:
                if install_packages_allowed(command):
                    return parts, None
                return parts, "安装的包不在 CODE_AGENT_INSTALL_PACKAGE_WHITELIST 白名单内"
            return parts, "pip 安装命令需要用户确认后才能执行"
        return parts, f"未批准的 pip 命令：{executable}"
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
    approved: bool = False,
) -> CommandResult:
    """在项目根目录执行白名单命令并收集有限输出。"""

    parts, blocked_reason = validate_command(command, root, approved=approved)
    if blocked_reason:
        return CommandResult(command, -1, "", blocked_reason=blocked_reason)

    environment = _sandboxed_environment()
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
