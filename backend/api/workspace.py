"""工作区项目、会话和代码索引接口。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from backend.schemas.workspace import WorkspaceAction
from backend.services.workspace.indexer import index_project
from backend.services.workspace.repository import (
    create_project,
    create_session,
    delete_session,
    list_workspace,
    update_session,
)

router = APIRouter(tags=["workspace"])


@router.get("/api/workspace")
async def get_workspace(
    code: str | None = Query(default=None),
    commerce: str | None = Query(default=None),
    media: str | None = Query(default=None),
) -> dict[str, object]:
    """返回本地项目列表和按插件开关筛选后的会话。"""

    workspace = await list_workspace(
        include_code=code == "1",
        include_commerce=commerce == "1",
        include_media=media == "1",
    )
    return workspace.model_dump(by_alias=True, exclude_none=True)


@router.post("/api/workspace")
async def post_workspace_action(body: WorkspaceAction) -> dict[str, object]:
    """处理创建项目、创建会话、更新会话和删除会话。"""

    try:
        if body.action == "createProject":
            if not body.root_path:
                raise ValueError("项目根目录不能为空")
            project = await create_project(body.root_path)
            return {"project": project.model_dump(by_alias=True)}

        if body.action == "createSession":
            session = await create_session(
                mode=body.mode or "qa",
                project_id=body.project_id,
                title=body.title or "新对话",
                messages=body.messages or [],
            )
            return {"session": session.model_dump(by_alias=True, exclude_none=True)}

        if body.action == "updateSession":
            if not body.id:
                raise ValueError("会话 ID 不能为空")
            session = await update_session(
                session_id=body.id,
                title=body.title or "新对话",
                messages=body.messages or [],
            )
            return {"session": session.model_dump(by_alias=True, exclude_none=True)}

        if body.action == "deleteSession":
            if body.id:
                await delete_session(body.id)
            return {"ok": True}

        raise ValueError(f"不支持的工作区操作：{body.action}")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/api/projects/{project_id}/index")
async def reindex_project(project_id: str) -> dict[str, object]:
    """重建指定项目的文本索引。"""

    try:
        return await index_project(project_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
