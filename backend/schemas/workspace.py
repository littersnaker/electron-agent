"""工作区、项目和会话接口的数据结构。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import Field

from backend.schemas.common import FlexibleModel, StoredMessage


class WorkspaceProject(FlexibleModel):
    """前端项目列表中的单个本地项目。"""

    id: str
    name: str
    root_path: str = Field(alias="rootPath")
    index_status: Literal["idle", "indexing", "ready", "error"] = Field(
        alias="indexStatus"
    )
    indexed_file_count: int = Field(alias="indexedFileCount")
    last_opened_at: str = Field(alias="lastOpenedAt")


class ChatSession(FlexibleModel):
    """一个 QA、Code 或 Commerce 会话。"""

    id: str
    title: str
    messages: list[StoredMessage]
    mode: Literal["qa", "code", "commerce", "media"]
    project_id: str | None = Field(default=None, alias="projectId")
    updated_at: str = Field(alias="updatedAt")


class WorkspaceResponse(FlexibleModel):
    """工作区列表接口响应。"""

    projects: list[WorkspaceProject]
    sessions: list[ChatSession]


class WorkspaceAction(FlexibleModel):
    """工作区写操作的统一请求体。"""

    action: str
    id: str | None = None
    root_path: str | None = Field(default=None, alias="rootPath")
    mode: Literal["qa", "code", "commerce", "media"] | None = None
    project_id: str | None = Field(default=None, alias="projectId")
    title: str | None = None
    messages: list[StoredMessage] | None = None
    extra_payload: dict[str, Any] | None = None
