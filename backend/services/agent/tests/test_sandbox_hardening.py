"""沙箱 A 层加固测试：env 裁剪与高危命令判定。"""

from __future__ import annotations

import os

from backend.services.agent.shared.command_runner import (
    _sandboxed_environment,
    is_high_risk_command,
    validate_command,
)


def test_sandboxed_environment_drops_api_keys(monkeypatch) -> None:
    """命令子进程环境不应携带任何 API Key / 宿主密钥。"""

    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-secret")
    monkeypatch.setenv("DASHSCOPE_API_KEY", "sk-dash")
    monkeypatch.setenv("TALORDATA_API_TOKEN", "tk-secret")
    monkeypatch.setenv("PATH", os.environ.get("PATH", ""))

    env = _sandboxed_environment()

    assert "DEEPSEEK_API_KEY" not in env
    assert "DASHSCOPE_API_KEY" not in env
    assert "TALORDATA_API_TOKEN" not in env
    # 基础变量保留，CI 常量始终注入。
    assert "PATH" in env
    assert env.get("CI") == "1"
    assert env.get("NO_COLOR") == "1"


def test_sandboxed_environment_keeps_allowlisted_variables(monkeypatch) -> None:
    """白名单内的基础变量应原样保留。"""

    monkeypatch.setenv("HOME", "/home/test")
    monkeypatch.setenv("LANG", "zh_CN.UTF-8")

    env = _sandboxed_environment()

    assert env.get("HOME") == "/home/test"
    assert env.get("LANG") == "zh_CN.UTF-8"


def test_high_risk_classification() -> None:
    """会执行工作区代码/配置的命令应判为高危。"""

    assert is_high_risk_command("pytest backend/tests")
    assert is_high_risk_command("pnpm test")
    assert is_high_risk_command("pnpm run build")
    assert is_high_risk_command("npx eslint src")
    assert is_high_risk_command("python -m pytest -q")
    assert is_high_risk_command("vitest run")


def test_low_risk_commands_not_flagged() -> None:
    """只读检查命令不应误判为高危。"""

    assert not is_high_risk_command("git status")
    assert not is_high_risk_command("git diff")


def test_scaffold_commands_still_validated_as_high_risk() -> None:
    """脚手架 create 命令目前不允许自动执行（判高危），需要走创建项目骨架。"""

    assert is_high_risk_command("pnpm create vite my-app --template react-ts")
    assert is_high_risk_command("npx create-react-app my-app")


def test_existing_whitelist_still_blocks_unsafe(monkeypatch) -> None:
    """沙箱加固后白名单校验保持不变：rm/管道仍被拒。"""

    import backend.services.agent.shared.command_runner as command_runner

    monkeypatch.setattr(command_runner, "_EXTRA_EXECUTABLES", set())
    monkeypatch.setattr(command_runner, "_EXTRA_PACKAGE_SCRIPTS", set())

    _, reason = validate_command("rm -rf /", __import__("pathlib").Path("."))
    assert reason and "未批准" in reason
    _, reason = validate_command("pnpm test | more", __import__("pathlib").Path("."))
    assert reason and "shell 控制符" in reason
