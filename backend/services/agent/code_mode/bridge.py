"""run_code 工具桥接：子进程 SDK 调用 → TOOL_GATEWAY 执行。

子进程内嵌的 tools_sdk.py 通过 stdin/stdout JSON 把工具调用发回父进程
（FastAPI 后端），父进程用现有 TOOL_GATEWAY 执行，完整复用 action_guard、
敏感路径过滤、命令白名单与权限校验。
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.services.tools.code_tools import execute_code_tool

_MAX_REQUEST_CHARS = 500_000
_MAX_PARALLEL_READS = 4


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
        """处理一条工具调用请求。"""

        tool = str(request.get("tool") or "").strip()
        arguments = request.get("arguments")
        if not isinstance(arguments, dict):
            arguments = {}
        if tool == "read_many":
            return await self._read_many(arguments)
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

    async def _read_many(self, arguments: dict[str, Any]) -> dict[str, Any]:
        paths = arguments.get("paths") or arguments.get("path") or []
        if not isinstance(paths, list) or not paths:
            return {"ok": False, "error": "read_many 需要 paths 数组"}
        paths = [str(path) for path in paths[: _MAX_PARALLEL_READS]]
        results: dict[str, Any] = {}
        errors: dict[str, str] = {}
        for path in paths:
            outcome = await self._call(
                "workspace.read", {"paths": [path]}, ("read",)
            )
            if outcome.get("ok"):
                results[path] = outcome.get("content") or ""
            else:
                errors[path] = str(outcome.get("error") or "读取失败")
        return {"ok": True, "results": results, "errors": errors}

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
        if isinstance(result, str):
            return {"ok": True, "content": result[: _MAX_REQUEST_CHARS]}
        return {"ok": True, "content": json.dumps(result, ensure_ascii=False)[: _MAX_REQUEST_CHARS]}


async def _serve_bridge(env: CodeModeEnvironment) -> int:
    """读取 stdin 的工具请求、逐条执行、写回 stdout。"""

    bridge = ToolsBridge(env)
    try:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                continue
            response = await bridge.dispatch(request)
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    except (BrokenPipeError, EOFError):
        return 0
    return 0


async def serve_code_mode(root: Path, work_id: str) -> int:
    """父进程入口：持续服务子进程的 SDK 工具请求。"""

    env = CodeModeEnvironment(root=root, work_id=work_id)
    return await _serve_bridge(env)


__all__ = ["CodeModeEnvironment", "serve_code_mode"]
