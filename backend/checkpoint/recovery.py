"""Checkpoint 恢复校验。"""

from __future__ import annotations

from typing import Any

from backend.services.checkpoints.store import AgentCheckpoint


class CheckpointRecovery:
    """在把持久化状态交给 Agent 前验证归属和可恢复性。"""

    def validate(
        self,
        checkpoint: AgentCheckpoint,
        *,
        session_id: str,
        agent_kind: str,
    ) -> dict[str, Any]:
        """返回可恢复状态；不匹配时抛出可理解的错误。"""

        if checkpoint.session_id != session_id:
            raise ValueError("Checkpoint 不属于当前会话")
        if checkpoint.agent_kind != agent_kind:
            raise ValueError("Checkpoint 与当前 Agent 类型不匹配")
        if not checkpoint.resumable:
            raise ValueError("Checkpoint 已完成或已被放弃，不能恢复")
        if checkpoint.status not in {"running", "paused", "interrupted", "failed"}:
            raise ValueError(f"Checkpoint 状态不可恢复：{checkpoint.status}")
        return dict(checkpoint.state)
