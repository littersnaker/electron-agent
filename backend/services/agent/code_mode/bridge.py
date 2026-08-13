"""run_code 工具桥接：子进程 SDK 请求 → TOOL_GATEWAY 执行。

子进程内嵌的 tools_sdk 通过 stdout 的 [REQ] 行把工具调用发到父进程
（FastAPI 后端），本模块用现有 TOOL_GATEWAY 执行，完整复用 action_guard、
敏感路径过滤、命令白名单与权限校验，再把 [RES] 写回子进程 stdin。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.services.tools.code_tools import execute_code_tool

_MAX_REQUEST_CHARS = 500_000


@dataclass(slots=True)
class CodeModeEnvironment:
    """一次 run_code 执行所需的工具执行上下文。"""

    root: Path
    work_id: str
    allowed_permissions: tuple[str, ...] = ("read", "write", "execute")


class ToolsBridge:
    """把子进程发来的 JSON 请求转成 TOOL_GATEWAY 调用并返回结果。"""

    def __init__(self, env: CodeModeEnvironment) -> None:
        self._env = env

    async def dispatch(self, request: dict[str, Any]) -> dict[str, Any]:
        """处理一条工具调用请求（子进程 SDK 并发请求带独立 id，互不串线）。"""

        tool = str(request.get("tool") or "").strip()
        arguments = request.get("arguments")
        if not isinstance(arguments, dict):
            arguments = {}
        if tool == "read":
            return await self._call("workspace.read", arguments, ("read",))
        if tool == "search":
            return await self._call("workspace.search", arguments, ("read",))
        if tool == "inspect":
            return await self._call("code.inspect", arguments, ("read",))
        if tool == "edit":
            return await self._call("workspace.edit", arguments, ("write",))
        if tool == "run":
            return await self._call("workspace.run", arguments, ("execute",))
        return {"ok": False, "error": f"不支持的 run_code 工具：{tool}"}

    async def _call(
        self,
        tool_name: str,
        arguments: dict[str, Any],
        permissions: tuple[str, ...],
    ) -> dict[str, Any]:
        try:
            result = await execute_code_tool(
                tool_name,
                root=self._env.root,
                arguments=arguments,
                permissions=permissions,
                agent_id=self._env.work_id,
            )
        except Exception as exc:  # noqa: BLE001 - 工具错误回传给子进程 try/except。
            return {"ok": False, "error": str(exc)[:500]}
        # 工具返回可能是 dataclass（如 workspace.read 的 ReadBatchResult），
        # 用 default=str 兜底序列化，保证 dispatch 永远不抛异常（否则 reader
        # task 崩溃，子进程等不到响应直接超时）。
        try:
            if isinstance(result, str):
                content = result
            else:
                content = json.dumps(result, ensure_ascii=False, default=str)
        except (TypeError, ValueError) as exc:
            return {"ok": False, "error": f"工具结果序列化失败：{exc}"}
        return {"ok": True, "content": content[: _MAX_REQUEST_CHARS]}


__all__ = ["CodeModeEnvironment", "ToolsBridge"]
