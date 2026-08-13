"""Coding Agent 工具在统一 Tool Gateway 中的注册与兼容调用。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, cast

from backend.services.agent.shared.proposal import apply_proposal
from backend.services.agent.shared.workspace_tools import file_version
from backend.services.code_intelligence.service import CodeIntelligenceService
from backend.services.sandbox import SANDBOX
from backend.services.tools.contracts import (
    ToolDefinition,
    ToolExecutionContext,
    ToolPermission,
    ToolRequest,
)
from backend.services.tools.gateway import TOOL_GATEWAY
from backend.services.tools.software_factory_tools import register_software_factory_tools
from backend.services.tools.validator import ToolValidator
from backend.utils.sensitive_paths import (
    partition_safe_workspace_paths,
    render_sensitive_skip,
)

_CODE_INTELLIGENCE = CodeIntelligenceService()
_VALIDATOR = ToolValidator()
_REGISTERED = False


async def _search(context: ToolExecutionContext, arguments: dict[str, Any]) -> str:
    """执行工作区全文搜索。"""

    query = str(arguments.get("query") or "").strip()
    if not query:
        raise ValueError("workspace.search 缺少 query")
    return await SANDBOX.filesystem.search(context.workspace_root, query)


async def _read(context: ToolExecutionContext, arguments: dict[str, Any]) -> object:
    """读取安全文件；敏感路径会被软过滤而不会消耗工具重试次数。"""

    paths = _paths(arguments.get("paths"))
    safe_paths, _blocked_paths = partition_safe_workspace_paths(paths)
    if safe_paths:
        _VALIDATOR.validate_relative_paths(context.workspace_root, safe_paths)
    offsets: dict[str, int] | None = None
    raw_offsets = arguments.get("offsets")
    if isinstance(raw_offsets, dict):
        offsets = {}
        for path, value in raw_offsets.items():
            try:
                offsets[str(path).strip()] = max(0, int(value))
            except (TypeError, ValueError):
                continue
    # Sandbox 会保留原始路径顺序，并在结果中返回 SECURITY SKIP 提示。
    return await SANDBOX.filesystem.read(context.workspace_root, paths, offsets=offsets)


async def _inspect(context: ToolExecutionContext, arguments: dict[str, Any]) -> str:
    """执行 AST 与影响分析，并在进入分析器前过滤敏感路径。"""

    paths = _paths(arguments.get("paths"), allow_empty=True)
    safe_paths, blocked_paths = partition_safe_workspace_paths(paths)
    if safe_paths:
        _VALIDATOR.validate_relative_paths(context.workspace_root, safe_paths)
    query = str(arguments.get("query") or "").strip()
    # inspect 可能触发 SymbolIndex 全库扫描，放到 worker 线程执行。
    observation = await asyncio.to_thread(
        _CODE_INTELLIGENCE.inspect,
        context.workspace_root,
        paths=safe_paths,
        query=query,
    )
    skip_message = render_sensitive_skip(blocked_paths)
    return f"{skip_message}\n\n{observation}".strip()


async def _edit(context: ToolExecutionContext, arguments: dict[str, Any]) -> object:
    """事务式应用解析后的 EditOperation 列表。"""

    operations = arguments.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("workspace.edit 缺少 operations")
    paths = [str(getattr(operation, "path", "")) for operation in operations]
    _VALIDATOR.validate_relative_paths(context.workspace_root, paths)
    expected_versions = arguments.get("expected_versions")
    if expected_versions is not None and not isinstance(expected_versions, dict):
        raise ValueError("expected_versions 必须是对象")
    return await SANDBOX.filesystem.edit(
        context.workspace_root,
        operations,
        expected_versions=cast(dict[str, str] | None, expected_versions),
    )


async def _filesystem(context: ToolExecutionContext, arguments: dict[str, Any]) -> object:
    """执行确定性重命名、移动或删除空目录操作。"""

    operations = arguments.get("operations")
    if not isinstance(operations, list) or not operations:
        raise ValueError("workspace.filesystem 缺少 operations")
    paths = [
        str(path)
        for operation in operations
        for path in (
            getattr(operation, "source_path", ""),
            getattr(operation, "target_path", ""),
        )
        if path
    ]
    _VALIDATOR.validate_relative_paths(context.workspace_root, paths)
    return await SANDBOX.filesystem.execute_operations(context.workspace_root, operations)


async def _run(context: ToolExecutionContext, arguments: dict[str, Any]) -> object:
    """执行白名单验证命令。"""

    command = str(arguments.get("command") or "").strip()
    if not command:
        raise ValueError("workspace.run 缺少 command")
    timeout_seconds = int(arguments.get("timeout_seconds") or 180)
    return await SANDBOX.shell.run(
        context.workspace_root,
        command,
        timeout_seconds=max(10, min(timeout_seconds, 600)),
    )


async def _apply_proposal(context: ToolExecutionContext, arguments: dict[str, Any]) -> object:
    """应用已经获得用户批准的建议模式文件提案。"""

    action = arguments.get("action")
    if not isinstance(action, dict):
        raise ValueError("workspace.apply_proposal 缺少 action")
    # apply_proposal 同步读写文件，放到 worker 线程执行。
    return await asyncio.to_thread(apply_proposal, context.workspace_root, action)


async def _file_version(context: ToolExecutionContext, arguments: dict[str, Any]) -> str:
    """返回一个工作区文件的 SHA-256 内容指纹。"""

    path = str(arguments.get("path") or "").strip()
    _VALIDATOR.validate_relative_paths(context.workspace_root, [path])
    return file_version(context.workspace_root, path)


def register_code_tools() -> None:
    """幂等注册 Coding Agent 需要的全部工具。"""

    global _REGISTERED
    if _REGISTERED:
        return

    definitions = (
        ToolDefinition("workspace.search", "搜索工作区文本", "read", _search, 60.0, 1),
        ToolDefinition("workspace.read", "读取工作区文本文件", "read", _read, 60.0, 1),
        ToolDefinition("code.inspect", "AST、符号、调用图和影响分析", "read", _inspect, 120.0, 0),
        ToolDefinition("workspace.file_version", "读取文件版本指纹", "read", _file_version, 30.0, 1),
        ToolDefinition("workspace.edit", "事务式修改工作区文件", "write", _edit, 180.0, 0),
        ToolDefinition("workspace.filesystem", "确定性文件系统操作", "write", _filesystem, 180.0, 0),
        ToolDefinition("workspace.apply_proposal", "应用已批准的文件提案", "write", _apply_proposal, 180.0, 0),
        ToolDefinition("workspace.run", "执行白名单验证命令", "execute", _run, 600.0, 0),
    )
    for definition in definitions:
        TOOL_GATEWAY.register(definition)

    # Software Factory 与基础文件工具共享同一 Gateway，避免高层生成器绕过权限审计。
    register_software_factory_tools()
    _REGISTERED = True


async def execute_code_tool(
    name: str,
    *,
    root: Path,
    arguments: dict[str, Any],
    permissions: set[ToolPermission],
    agent_id: str,
    task_id: str = "",
) -> Any:
    """为旧 Code Agent 提供最小兼容调用，并强制经过 Tool Gateway。"""

    register_code_tools()
    result = await TOOL_GATEWAY.execute(
        ToolRequest(name=name, arguments=arguments),
        context=ToolExecutionContext(
            agent_id=agent_id,
            workspace_root=root,
            allowed_permissions=frozenset(permissions),
            task_id=task_id,
        ),
    )
    return result.raw


def _paths(value: object, *, allow_empty: bool = False) -> list[str]:
    """把工具参数中的 paths 转换成去重非空字符串列表。"""

    if value is None and allow_empty:
        return []
    if not isinstance(value, list):
        raise ValueError("paths 必须是数组")
    paths = list(dict.fromkeys(str(item).strip() for item in value if str(item).strip()))
    if not paths and not allow_empty:
        raise ValueError("paths 不能为空")
    return paths
