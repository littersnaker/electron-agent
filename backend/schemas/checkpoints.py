"""Agent Checkpoint API 数据结构。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from backend.schemas.common import FlexibleModel


class CheckpointCreateBody(FlexibleModel):
    """创建通用 Agent Checkpoint。"""

    session_id: str = Field(alias="sessionId")
    agent_kind: Literal["qa", "code", "media", "commerce"] = Field(
        alias="agentKind"
    )
    route: str
    request: dict[str, Any] = Field(default_factory=dict)
    label: str = ""
    checkpoint_id: str = Field(default="", alias="checkpointId")


class CheckpointUpdateBody(FlexibleModel):
    """更新 Checkpoint 状态或执行快照。"""

    status: Literal[
        "running", "paused", "interrupted", "failed", "completed", "discarded"
    ] | None = None
    state: dict[str, Any] | None = None
    request: dict[str, Any] | None = None
    error_message: str | None = Field(default=None, alias="errorMessage")
    resumable: bool | None = None
