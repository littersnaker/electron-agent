"""所有 Agent 共用的 Checkpoint 管理接口。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from backend.schemas.checkpoints import CheckpointCreateBody, CheckpointUpdateBody
from backend.services.checkpoints.store import (
    create_checkpoint,
    delete_checkpoint,
    get_checkpoint,
    get_latest_resumable,
    update_checkpoint,
)

router = APIRouter(prefix="/api/checkpoints", tags=["checkpoints"])


@router.get("/latest")
async def latest_checkpoint(session_id: str = Query(alias="sessionId")) -> dict[str, object]:
    """返回当前会话最近的可恢复快照。"""

    checkpoint = await get_latest_resumable(session_id)
    return {"checkpoint": checkpoint.to_json() if checkpoint else None}


@router.get("/{checkpoint_id}")
async def read_checkpoint(checkpoint_id: str) -> dict[str, object]:
    """读取指定快照。"""

    checkpoint = await get_checkpoint(checkpoint_id)
    if checkpoint is None:
        raise HTTPException(status_code=404, detail="Checkpoint 不存在")
    return {"checkpoint": checkpoint.to_json()}


@router.post("")
async def create_agent_checkpoint(body: CheckpointCreateBody) -> dict[str, object]:
    """创建可恢复执行快照。"""

    checkpoint = await create_checkpoint(
        session_id=body.session_id,
        agent_kind=body.agent_kind,
        route=body.route,
        request=body.request,
        label=body.label,
        checkpoint_id=body.checkpoint_id,
    )
    return {"checkpoint": checkpoint.to_json()}


@router.put("/{checkpoint_id}")
async def patch_agent_checkpoint(
    checkpoint_id: str,
    body: CheckpointUpdateBody,
) -> dict[str, object]:
    """更新执行状态、可恢复数据或错误信息。"""

    checkpoint = await update_checkpoint(
        checkpoint_id,
        status=body.status,
        state=body.state,
        request=body.request,
        error_message=body.error_message,
        resumable=body.resumable,
    )
    if checkpoint is None:
        raise HTTPException(status_code=404, detail="Checkpoint 不存在")
    return {"checkpoint": checkpoint.to_json()}


@router.delete("/{checkpoint_id}")
async def discard_agent_checkpoint(checkpoint_id: str) -> dict[str, bool]:
    """删除用户明确放弃的快照。"""

    return {"deleted": await delete_checkpoint(checkpoint_id)}
