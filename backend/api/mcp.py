"""MCP Server 和工具目录状态接口。"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.services.mcp.executor import execute_mcp_tool
from backend.services.mcp.client import load_server_configs, resolve_tools
from backend.services.workspace.repository import get_project

router = APIRouter(tags=["mcp"])


class McpToolCallRequest(BaseModel):
    """手动调用 MCP 工具的请求体。"""

    project_id: str | None = Field(default=None, alias="projectId")
    tool_name: str = Field(alias="toolName")
    arguments: dict[str, object] = Field(default_factory=dict)


@router.get("/api/mcp/status")
async def get_mcp_status(project_id: str | None = Query(default=None, alias="projectId")) -> dict[str, object]:
    """返回当前项目可见的 MCP 服务和工具，但不返回任何认证请求头。"""

    if not project_id:
        return {"projectId": None, "projectName": None, "servers": [], "tools": [], "errors": []}
    try:
        project = await get_project(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # 仓库层为了便于 JSON 序列化，把路径保存成字符串；
    # MCP 客户端需要 Path 对象来查找项目根目录下的 .agent-mcp.json。
    working_dir = Path(project.root_path)
    servers = load_server_configs(working_dir)
    tools, errors = await resolve_tools(working_dir)
    return {
        "projectId": project.id,
        "projectName": project.name,
        "servers": [
            {
                "id": server["id"],
                "name": server["name"],
                "url": server["url"],
                "enabled": server["enabled"],
                "requireApproval": server["requireApproval"],
            }
            for server in servers
        ],
        "tools": [
            {
                "serverId": tool["serverId"],
                "serverName": tool["serverName"],
                "name": tool["llmName"],
                "remoteName": tool["remoteName"],
                "description": tool["description"],
                "requiresApproval": tool["requiresApproval"],
            }
            for tool in tools
        ],
        "errors": errors,
    }


@router.post("/api/mcp/tools/call")
async def post_mcp_tool_call(body: McpToolCallRequest) -> dict[str, object]:
    """手动调用一个已发现的 MCP 工具（用户显式操作，视为已审批）。"""

    if not body.project_id:
        raise HTTPException(status_code=400, detail="缺少 projectId")
    try:
        project = await get_project(body.project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result = await execute_mcp_tool(
        Path(project.root_path),
        body.tool_name,
        body.arguments,
        approved=True,
    )
    if not result.get("ok"):
        status_code = 403 if result.get("approvalNeeded") else 502
        raise HTTPException(status_code=status_code, detail=str(result.get("message") or result.get("error")))
    return result
