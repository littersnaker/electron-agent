"""Sandbox Shell 外观。"""

from __future__ import annotations

from pathlib import Path

from backend.services.agent.command_runner import CommandResult, run_safe_command


class SandboxShell:
    """只允许现有白名单命令在项目根目录执行。"""

    async def run(
        self,
        root: Path,
        command: str,
        *,
        timeout_seconds: int = 180,
    ) -> CommandResult:
        """调用无 shell、有限输出且带超时的安全命令执行器。"""

        return await run_safe_command(
            root,
            command,
            timeout_seconds=timeout_seconds,
        )
