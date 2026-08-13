"""命令审批门测试：分类、白名单、批准放行与 pending 持久化。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.agent.shared.command_runner import (
    command_approval_enabled,
    install_packages_allowed,
    requires_user_approval,
    validate_command,
)


def test_command_approval_default_enabled(monkeypatch) -> None:
    """审批门默认开启；显式设 0 关闭。"""

    monkeypatch.delenv("CODE_AGENT_COMMAND_APPROVAL", raising=False)
    assert command_approval_enabled()
    monkeypatch.setenv("CODE_AGENT_COMMAND_APPROVAL", "0")
    assert not command_approval_enabled()


def test_auto_edit_exposes_run_when_approval_enabled(monkeypatch) -> None:
    """审批门开启时自动编辑模式暴露 run，供安装命令走审批；关闭后不暴露。"""

    from backend.services.agent.shared.tool_registry import tool_names_for_mode

    monkeypatch.setenv("CODE_AGENT_COMMAND_APPROVAL", "1")
    assert "run" in tool_names_for_mode(execution_mode="auto_edit")
    monkeypatch.setenv("CODE_AGENT_COMMAND_APPROVAL", "0")
    assert "run" not in tool_names_for_mode(execution_mode="auto_edit")


def test_requires_user_approval_install_commands() -> None:
    """安装/初始化/脚手架命令应标记为需要用户审批。"""

    assert requires_user_approval("pnpm install")
    assert requires_user_approval("pnpm add gsap")
    assert requires_user_approval("npm create vite my-app --template react-ts")
    assert requires_user_approval("npx create-vite my-app")
    assert requires_user_approval("pip install requests")
    assert requires_user_approval("python -m pip install gsap")


def test_requires_user_approval_regular_commands() -> None:
    """质量校验命令不应进入审批门。"""

    assert not requires_user_approval("pnpm test")
    assert not requires_user_approval("pnpm run build")
    assert not requires_user_approval("npx eslint src")
    assert not requires_user_approval("git status")
    assert not requires_user_approval("pytest backend/tests")


def test_install_package_whitelist(monkeypatch) -> None:
    """白名单为空放行；设置后只允许白名单包。"""

    monkeypatch.delenv("CODE_AGENT_INSTALL_PACKAGE_WHITELIST", raising=False)
    assert install_packages_allowed("pnpm add gsap")

    monkeypatch.setenv("CODE_AGENT_INSTALL_PACKAGE_WHITELIST", "gsap")
    assert install_packages_allowed("pnpm add gsap")
    assert install_packages_allowed("pnpm add gsap -D")
    assert not install_packages_allowed("pnpm add react")
    assert not install_packages_allowed("python -m pip install requests")
    # 无包名的 install（按 lockfile 安装）不受白名单限制。
    assert install_packages_allowed("pnpm install")


def test_validate_command_approval_gate(monkeypatch) -> None:
    """未批准时拦截，批准后放行；白名单外包即使批准也拦截。"""

    monkeypatch.setenv("CODE_AGENT_INSTALL_PACKAGE_WHITELIST", "")
    _parts, reason = validate_command("pnpm install", Path.cwd())
    assert reason and "用户确认" in reason
    parts, reason = validate_command(
        "pnpm install", Path.cwd(), approved=True
    )
    assert reason is None
    assert parts == ["pnpm", "install"]

    monkeypatch.setenv("CODE_AGENT_INSTALL_PACKAGE_WHITELIST", "gsap")
    _parts, reason = validate_command(
        "pnpm add react", Path.cwd(), approved=True
    )
    assert reason and "白名单" in reason
    parts, reason = validate_command("pnpm add gsap", Path.cwd(), approved=True)
    assert reason is None
    assert parts == ["pnpm", "add", "gsap"]


@pytest.mark.asyncio
async def test_pending_command_store_flow(tmp_path: Path, monkeypatch) -> None:
    """pending 命令保存、批准、消费与换命令清理。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    from backend.core.config import get_settings

    get_settings.cache_clear()
    from backend.services.workspace.database import initialize_database

    await initialize_database()

    from backend.services.agent.worker.pending import (
        consume_pending_command,
        find_pending_command,
        find_pending_command_by_request_id,
        resolve_pending_command,
        save_pending_command,
    )

    await save_pending_command(
        request_id="approval_1",
        session_id="s1",
        work_id="W001",
        command="pnpm install",
        checkpoint_id="cp-1",
    )
    pending = await find_pending_command("W001")
    assert pending is not None
    assert pending["status"] == "pending"
    assert pending["checkpointId"] == "cp-1"

    # 未批准前消费不到决定。
    assert await consume_pending_command("W001", "pnpm install") is None

    await resolve_pending_command("approval_1", approved=True)
    by_id = await find_pending_command_by_request_id("approval_1")
    assert by_id is not None and by_id["status"] == "approved"

    assert await consume_pending_command("W001", "pnpm install") == "approved"
    # 消费后旧决定消失；不同命令不匹配。
    assert await consume_pending_command("W001", "pnpm install") is None

    # 保存新命令会清掉旧记录，避免串台。
    await save_pending_command(
        request_id="approval_2",
        session_id="s1",
        work_id="W001",
        command="pnpm add gsap",
        checkpoint_id="cp-2",
    )
    pending = await find_pending_command("W001")
    assert pending is not None and pending["command"] == "pnpm add gsap"
    assert await find_pending_command_by_request_id("approval_1") is None


def test_ledger_paused_status_keeps_attempt_count() -> None:
    """paused 恢复不应重复累计尝试次数，且 ready_items 包含 paused。"""

    from backend.services.agent.shared.work_models import WorkItem, WorkLedger

    work = WorkItem(id="W001", title="t", objective="o")
    ledger = WorkLedger([work])
    ledger.begin("W001")
    assert work.status == "running"
    assert work.attempts == 1

    work.status = "paused"
    # paused 不应被“恢复中断”逻辑重置为 pending。
    ledger.reset_interrupted_running()
    assert work.status == "paused"
    assert "W001" in [item.id for item in ledger.ready_items()]
    ledger.begin("W001")
    assert work.status == "running"
    assert work.attempts == 1
