"""受工作区边界保护的 Sandbox 文件系统外观。"""

from __future__ import annotations

import asyncio
from pathlib import Path

from backend.services.agent.filesystem_executor import (
    FileSystemExecutionResult,
    execute_filesystem_operations,
)
from backend.services.agent.loop_protocol import EditOperation
from backend.services.agent.work_models import FileSystemOperation
from backend.services.agent.workspace_tools import (
    EditBatchResult,
    ReadBatchResult,
    apply_edit_operations,
    read_workspace_files_with_versions,
    search_workspace,
)


class SandboxFilesystem:
    """统一包装搜索、读取、编辑和确定性文件操作。"""

    async def search(self, root: Path, query: str) -> str:
        """在线程池中扫描工作区文本，避免阻塞 FastAPI 事件循环。"""

        return await asyncio.to_thread(search_workspace, root, query)

    async def read(
        self,
        root: Path,
        paths: list[str],
        offsets: dict[str, int] | None = None,
    ) -> ReadBatchResult:
        """读取多个文本文件（支持字符偏移续读），并返回版本指纹。"""

        return await asyncio.to_thread(
            read_workspace_files_with_versions,
            root,
            paths,
            offsets,
        )

    async def edit(
        self,
        root: Path,
        operations: list[EditOperation],
        *,
        expected_versions: dict[str, str] | None = None,
    ) -> EditBatchResult:
        """事务式应用编辑，并在版本不一致时拒绝覆盖。"""

        return await asyncio.to_thread(
            apply_edit_operations,
            root,
            operations,
            expected_versions=expected_versions,
        )

    async def execute_operations(
        self,
        root: Path,
        operations: list[FileSystemOperation],
    ) -> FileSystemExecutionResult:
        """执行重命名、移动和删除空目录等确定性操作。"""

        return await asyncio.to_thread(execute_filesystem_operations, root, operations)
