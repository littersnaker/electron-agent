"""MCP 工具执行器：按 ``mcp__server__tool`` 解析并调用，带审批门。"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from backend.services.mcp.client import call_tool, load_server_configs, resolve_tools


class McpExecutionError(RuntimeError):
    """MCP 工具解析/调用失败（信息已提取为可读文本）。"""


async def resolve_mcp_tool(
    working_dir: Path, llm_name: str
) -> tuple[dict[str, Any], dict[str, Any]]:
    """按 ``mcp__server__tool`` 名称解析出 server 与工具元数据。"""

    servers = {server["id"]: server for server in load_server_configs(working_dir)}
    tools, _errors = await resolve_tools(working_dir)
    for tool in tools:
        if tool["llmName"] == llm_name:
            server = servers.get(str(tool["serverId"]))
            if server is None:
                raise McpExecutionError(
                    f"MCP server {tool['serverId']} 未启用或未配置"
                )
            return server, tool
    raise McpExecutionError(f"未找到 MCP 工具：{llm_name}")


async def execute_mcp_tool(
    working_dir: Path,
    llm_name: str,
    arguments: dict[str, Any] | None = None,
    *,
    approved: bool = False,
) -> dict[str, Any]:
    """执行一次 MCP 工具调用，返回结构化结果。

    需要审批且未批准时返回 ``approvalNeeded`` 标记（不执行）；调用失败返回
    ``error`` 而不抛异常，便于 Agent 把错误作为工具结果继续下一轮。
    """

    try:
        server, tool = await resolve_mcp_tool(working_dir, llm_name)
    except McpExecutionError as exc:
        return {"ok": False, "toolName": llm_name, "error": str(exc)}

    if tool.get("requiresApproval") and not approved:
        return {
            "ok": False,
            "approvalNeeded": True,
            "toolName": llm_name,
            "message": "该 MCP 工具需要用户审批，请通过 MCP 面板确认后调用。",
        }

    try:
        result = await call_tool(
            server,
            tool_name=str(tool["remoteName"]),
            arguments=arguments or {},
        )
    except Exception as exc:  # noqa: BLE001 - 工具错误统一转为结构化结果
        return {"ok": False, "toolName": llm_name, "error": str(exc)}

    text = _extract_content_text(result)
    return {
        "ok": True,
        "toolName": llm_name,
        "content": text,
        "isError": bool(result.get("isError")),
    }


def _extract_content_text(result: dict[str, Any]) -> str:
    """把 MCP ``content`` 数组里的文本片段拼接为纯文本。"""

    parts: list[str] = []
    for item in result.get("content") or []:
        if isinstance(item, dict):
            text = str(item.get("text") or "")
            if text:
                parts.append(text)
        elif isinstance(item, str) and item.strip():
            parts.append(item)
    return "\n".join(parts)


__all__ = ["McpExecutionError", "execute_mcp_tool", "resolve_mcp_tool"]
