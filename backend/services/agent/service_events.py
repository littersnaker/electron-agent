"""Code Agent 主编排共用的 SSE 事件构造器。"""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Any
from uuid import uuid4

from backend.utils.sse import encode_sse


def lifecycle(
    *,
    role: str,
    status: str,
    detail: str,
    iteration: int = 0,
    slot: int | None = None,
    tool_name: str | None = None,
) -> dict[str, Any]:
    """创建与 React Agent 面板兼容的生命周期事件。"""

    payload: dict[str, Any] = {
        "id": f"life_{uuid4().hex}",
        "agentId": role if slot is None else f"{role}_{slot}",
        "role": role,
        "status": status.upper(),
        "iteration": iteration,
        "detail": detail,
        "createdAt": datetime.now(UTC).isoformat(),
    }
    if slot is not None:
        payload["slot"] = slot
    if tool_name:
        payload["toolName"] = tool_name
    return payload


def usage_packet(prompt: int, completion: int, total: int) -> str:
    """生成前端 Token 统计 SSE 帧。"""

    return encode_sse(
        {
            "type": "USAGE",
            "content": {
                "prompt": prompt,
                "completion": completion,
                "total": total,
                "unit": "tokens",
                "label": "Tokens",
            },
        }
    )


def workspace_info_text(project: object) -> str:
    """把项目对象转换成用户可读的工作区说明。"""

    return (
        f"当前 Code 会话已绑定项目：**{project.name}**\n\n"
        f"- 项目路径：`{project.root_path}`\n"
        f"- 索引状态：`{project.index_status}`\n"
        f"- 已索引文件：{project.indexed_file_count} 个"
    )
