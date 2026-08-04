"""Code Agent 新建和恢复 Checkpoint 的入口逻辑。"""

from __future__ import annotations

from typing import Any

from backend.schemas.chat import ChatRequest
from backend.services.checkpoints.store import (
    create_checkpoint,
    get_checkpoint,
    update_checkpoint,
)


async def resolve_run_checkpoint(
    body: ChatRequest,
) -> tuple[str, dict[str, Any] | None]:
    """创建新快照或读取可继续的 Code Agent 精确状态。"""

    resume_id = body.resume_checkpoint_id.strip()
    if resume_id:
        checkpoint = await get_checkpoint(resume_id)
        if checkpoint is None:
            raise ValueError("需要恢复的 Checkpoint 不存在")
        if checkpoint.session_id != body.session_id or checkpoint.agent_kind != "code":
            raise ValueError("Checkpoint 与当前 Code 会话不匹配")
        await update_checkpoint(
            resume_id,
            status="running",
            resumable=True,
            request=body.model_dump(by_alias=True),
            error_message="",
        )
        loop_state = checkpoint.state.get("codeLoop")
        return resume_id, loop_state if isinstance(loop_state, dict) else None

    checkpoint_id = body.checkpoint_id.strip()
    if checkpoint_id and await get_checkpoint(checkpoint_id):
        await update_checkpoint(checkpoint_id, status="running", resumable=True)
        return checkpoint_id, None

    checkpoint = await create_checkpoint(
        session_id=body.session_id,
        agent_kind="code",
        route="/api/chat",
        request=body.model_dump(by_alias=True),
        label="Code Agent 代码任务",
        checkpoint_id=checkpoint_id,
    )
    return checkpoint.id, None
