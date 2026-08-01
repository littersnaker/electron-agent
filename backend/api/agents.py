"""Agent 能力与工具诊断接口。"""

from __future__ import annotations

from fastapi import APIRouter

from backend.services.agent.tool_registry import public_tool_catalog

router = APIRouter(tags=["agents"])


@router.get("/api/agents/tools")
async def get_agent_tools() -> dict[str, object]:
    """返回当前 Python 后端实际启用的 Code Agent 工具目录。"""

    return {
        "tools": public_tool_catalog(),
        "readOnlyTools": ["search", "read", "finish"],
        "note": "工具由 Python 后端执行；只读分析与代码修改都会使用同一目录。",
    }
