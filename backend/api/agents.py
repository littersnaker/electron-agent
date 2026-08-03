"""Agent Runtime、Skills 与工具诊断接口。"""

from __future__ import annotations

from fastapi import APIRouter

from backend.runtime.bootstrap import RUNTIME
from backend.services.agent.tool_registry import public_tool_catalog

router = APIRouter(tags=["agents"])


@router.get("/api/agents/tools")
async def get_agent_tools() -> dict[str, object]:
    """返回兼容旧前端的工具目录，以及新 Runtime 的完整注册信息。"""

    await RUNTIME.initialize()
    catalog = RUNTIME.catalog()
    return {
        "tools": public_tool_catalog(),
        "readOnlyTools": ["search", "read", "inspect", "finish"],
        "runtimeTools": catalog["tools"],
        "agents": catalog["agents"],
        "skills": catalog["skills"],
        "note": "所有 Code Agent 工具均由 Python Tool Gateway 校验权限、超时和结果过滤。",
    }


@router.get("/api/agents/runtime/tasks")
async def get_runtime_tasks() -> dict[str, object]:
    """返回当前后端进程内的 Runtime 任务快照，便于本地诊断。"""

    await RUNTIME.initialize()
    return {"tasks": await RUNTIME.task_snapshot()}
