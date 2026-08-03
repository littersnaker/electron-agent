"""统一 Runtime 使用的 Checkpoint Store 外观。

底层继续复用已经通过测试的 ``backend.services.checkpoints.store``，从而保持旧 Code Agent
快照格式和前端恢复接口不变，避免在迁移阶段维护两套持久化实现。
"""

from __future__ import annotations

from typing import Any

from backend.services.checkpoints.store import (
    AgentCheckpoint,
    create_checkpoint,
    get_checkpoint,
    update_checkpoint,
)


class CheckpointStore:
    """为 Runtime 提供面向对象的 Checkpoint 访问接口。"""

    async def create(
        self,
        *,
        session_id: str,
        agent_kind: str,
        route: str,
        request: dict[str, Any],
        label: str,
    ) -> AgentCheckpoint:
        """创建一条运行中 Checkpoint。"""

        return await create_checkpoint(
            session_id=session_id,
            agent_kind=agent_kind,
            route=route,
            request=request,
            label=label,
        )

    async def get(self, checkpoint_id: str) -> AgentCheckpoint | None:
        """按 ID 读取 Checkpoint。"""

        return await get_checkpoint(checkpoint_id)

    async def update(
        self,
        checkpoint_id: str,
        *,
        status: str | None = None,
        state: dict[str, Any] | None = None,
        error_message: str | None = None,
        resumable: bool | None = None,
    ) -> AgentCheckpoint | None:
        """局部更新 Checkpoint，不覆盖未提供字段。"""

        return await update_checkpoint(
            checkpoint_id,
            status=status,
            state=state,
            error_message=error_message,
            resumable=resumable,
        )
