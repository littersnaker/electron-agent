"""QA 与 Code Agent 请求结构。"""

from __future__ import annotations

from pydantic import Field

from backend.schemas.common import FlexibleModel, FrontendAttachment, FrontendMessage


class ChatRequest(FlexibleModel):
    """前端聊天请求。"""

    messages: list[FrontendMessage] = Field(default_factory=list)
    attachments: list[FrontendAttachment] = Field(default_factory=list)
    session_id: str = Field(default="default-thread", alias="sessionId")
    working_dir: str = Field(default="", alias="workingDir")
    project_id: str = Field(default="", alias="projectId")
