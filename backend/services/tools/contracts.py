"""Tool Gateway 使用的数据契约。"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

ToolPermission = Literal["read", "write", "execute", "control"]


@dataclass(frozen=True, slots=True)
class ToolExecutionContext:
    """保存一次工具调用的 Agent、工作区与权限上下文。"""

    agent_id: str
    workspace_root: Path
    allowed_permissions: frozenset[ToolPermission]
    task_id: str = ""
    metadata: dict[str, Any] = field(default_factory=dict)


ToolHandler = Callable[[ToolExecutionContext, dict[str, Any]], Awaitable[Any]]


@dataclass(frozen=True, slots=True)
class ToolDefinition:
    """描述一个已注册工具及其执行策略。"""

    name: str
    description: str
    permission: ToolPermission
    handler: ToolHandler
    timeout_seconds: float = 180.0
    maximum_retries: int = 0


@dataclass(frozen=True, slots=True)
class ToolRequest:
    """保存工具名和经过协议解析的参数。"""

    name: str
    arguments: dict[str, Any]


@dataclass(frozen=True, slots=True)
class ToolExecutionResult:
    """同时保存业务原始结果和可安全注入上下文的过滤结果。"""

    tool_name: str
    raw: Any
    filtered: Any
    attempts: int
