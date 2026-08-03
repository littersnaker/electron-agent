"""聚合文件系统和 Shell 的 Sandbox Executor。"""

from __future__ import annotations

from backend.sandbox.filesystem import SandboxFilesystem
from backend.sandbox.shell import SandboxShell


class SandboxExecutor:
    """向 Tool Gateway 暴露单一 Sandbox 依赖。"""

    def __init__(self) -> None:
        """创建文件系统与 Shell 子执行器。"""

        self.filesystem = SandboxFilesystem()
        self.shell = SandboxShell()


SANDBOX = SandboxExecutor()
