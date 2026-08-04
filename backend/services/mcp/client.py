"""MCP 配置读取和工具目录发现客户端。

当前桌面应用只在状态页发现工具，不会自动调用远程 MCP 工具。这样既保留原项目的
插件可见性，又避免在用户没有确认时执行外部写入操作。
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

import httpx


MCP_PROTOCOL_VERSION = "2025-11-25"
ENV_PATTERN = re.compile(r"\$\{([A-Za-z_][A-Za-z0-9_]*)\}")


def _interpolate_environment(value: str) -> str:
    """把配置文本中的 ``${ENV_NAME}`` 替换为当前环境变量值。"""

    return ENV_PATTERN.sub(lambda match: os.getenv(match.group(1), ""), value)


def _normalize_server(raw: dict[str, Any]) -> dict[str, Any]:
    """校验并清理一条 MCP Server 配置。"""

    server_id = str(raw.get("id") or "").strip()
    url = str(raw.get("url") or "").strip()
    if not server_id:
        raise ValueError("MCP server.id 不能为空")
    if not url.startswith(("http://", "https://")):
        raise ValueError(f"MCP 服务 {server_id} 只支持 http/https 地址")
    headers = {
        str(key).strip(): _interpolate_environment(str(value))
        for key, value in dict(raw.get("headers") or {}).items()
        if str(key).strip() and _interpolate_environment(str(value))
    }
    approvals = [
        str(item).strip()
        for item in list(raw.get("requireApproval") or [])
        if str(item).strip()
    ]
    return {
        "id": server_id,
        "name": str(raw.get("name") or server_id).strip(),
        "url": url,
        "enabled": raw.get("enabled") is not False,
        "headers": headers,
        "requireApproval": list(dict.fromkeys(approvals)),
    }


def _read_configuration_value(value: Any) -> list[dict[str, Any]]:
    """把数组或 ``{servers: []}`` 配置转换成统一列表。"""

    raw_servers = value if isinstance(value, list) else value.get("servers", []) if isinstance(value, dict) else []
    servers: list[dict[str, Any]] = []
    for raw in raw_servers:
        if not isinstance(raw, dict):
            continue
        server = _normalize_server(raw)
        if server["enabled"]:
            servers.append(server)
    return servers


def load_server_configs(working_dir: Path) -> list[dict[str, Any]]:
    """按“环境变量优先、项目文件补充”的顺序读取 MCP 配置。"""

    configured: list[dict[str, Any]] = []
    raw_environment = os.getenv("MCP_SERVERS_JSON", "").strip()
    if raw_environment:
        try:
            configured.extend(_read_configuration_value(json.loads(raw_environment)))
        except (json.JSONDecodeError, ValueError):
            pass

    config_path = working_dir.resolve() / ".agent-mcp.json"
    if config_path.is_file():
        try:
            configured.extend(_read_configuration_value(json.loads(config_path.read_text("utf-8"))))
        except (OSError, json.JSONDecodeError, ValueError):
            pass

    unique: dict[str, dict[str, Any]] = {}
    for server in configured:
        unique.setdefault(server["id"], server)
    return list(unique.values())


async def _post_rpc(
    client: httpx.AsyncClient,
    server: dict[str, Any],
    request_id: int,
    method: str,
    params: dict[str, Any] | None = None,
    session_id: str | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    """向一个 MCP HTTP Server 发送 JSON-RPC 请求。"""

    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        **server["headers"],
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    response = await client.post(
        server["url"],
        headers=headers,
        json={"jsonrpc": "2.0", "id": request_id, "method": method, **({"params": params} if params else {})},
    )
    response.raise_for_status()
    returned_session = response.headers.get("mcp-session-id") or session_id
    text = response.text.strip()
    if not text:
        return None, returned_session
    if "text/event-stream" in response.headers.get("content-type", ""):
        payloads = [line[5:].strip() for line in text.splitlines() if line.startswith("data:")]
        text = next((item for item in reversed(payloads) if item and item != "[DONE]"), "{}")
    parsed = json.loads(text)
    if isinstance(parsed, dict) and parsed.get("error"):
        error = parsed["error"]
        raise RuntimeError(str(error.get("message") if isinstance(error, dict) else error))
    return parsed.get("result") if isinstance(parsed, dict) else None, returned_session


async def _post_notification(
    client: httpx.AsyncClient,
    server: dict[str, Any],
    method: str,
    session_id: str | None = None,
) -> None:
    """发送不需要 JSON-RPC 响应的 MCP 通知消息。"""

    headers = {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        **server["headers"],
    }
    if session_id:
        headers["Mcp-Session-Id"] = session_id
    response = await client.post(
        server["url"],
        headers=headers,
        json={"jsonrpc": "2.0", "method": method},
    )
    response.raise_for_status()


async def discover_server_tools(server: dict[str, Any]) -> list[dict[str, Any]]:
    """初始化 MCP 会话并读取单个 Server 的工具目录。"""

    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        _, session_id = await _post_rpc(
            client,
            server,
            1,
            "initialize",
            {
                "protocolVersion": MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "multi-agent-workspace", "version": "1.0.0"},
            },
        )
        await _post_notification(
            client,
            server,
            "notifications/initialized",
            session_id=session_id,
        )
        result, _ = await _post_rpc(client, server, 2, "tools/list", session_id=session_id)
    tools = result.get("tools", []) if isinstance(result, dict) else []
    resolved: list[dict[str, Any]] = []
    for tool in tools:
        if not isinstance(tool, dict) or not tool.get("name"):
            continue
        remote_name = str(tool["name"])
        requires_approval = "*" in server["requireApproval"] or remote_name in server["requireApproval"]
        safe_server = re.sub(r"[^A-Za-z0-9_]", "_", server["id"])
        safe_tool = re.sub(r"[^A-Za-z0-9_]", "_", remote_name)
        resolved.append(
            {
                "serverId": server["id"],
                "serverName": server["name"],
                "remoteName": remote_name,
                "llmName": f"mcp__{safe_server}__{safe_tool}",
                "description": tool.get("description") or tool.get("title") or f"调用远程工具 {remote_name}。",
                "inputSchema": tool.get("inputSchema") or {"type": "object", "properties": {}},
                "requiresApproval": requires_approval,
            }
        )
    return resolved


async def resolve_tools(working_dir: Path) -> tuple[list[dict[str, Any]], list[str]]:
    """发现所有已启用 MCP Server 的工具，并收集不可用服务的错误。"""

    tools: list[dict[str, Any]] = []
    errors: list[str] = []
    for server in load_server_configs(working_dir):
        try:
            tools.extend(await discover_server_tools(server))
        except (httpx.HTTPError, RuntimeError, json.JSONDecodeError) as exc:
            errors.append(f"{server['name']}：{exc}")
    unique = {tool["llmName"]: tool for tool in tools}
    return list(unique.values()), errors
