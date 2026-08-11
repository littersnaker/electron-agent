"""复盘循环的设置与审批接口。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.services.agent.reflection.eval import memory_eval_stats
from backend.services.agent.reflection.search import session_search
from backend.services.agent.reflection.settings import (
    ReviewSettings,
    read_review_settings,
    write_review_settings,
)
from backend.services.agent.reflection.skills import apply_skill_updates
from backend.services.agent.reflection.store import (
    get_review_artifact,
    list_review_artifacts,
    update_review_artifact_status,
)

router = APIRouter(prefix="/api/agent", tags=["agent-review"])


class ReviewSettingsUpdate(BaseModel):
    """复盘模型设置更新体。"""

    modelId: str = Field(default="", max_length=200)
    enabled: bool = True
    minComplexity: int = Field(default=5, ge=0, le=100)


@router.get("/review-settings")
async def get_review_settings() -> dict[str, object]:
    """返回复盘设置（modelId + enabled）。"""

    settings = await read_review_settings()
    return settings.to_json()


@router.put("/review-settings")
async def put_review_settings(body: ReviewSettingsUpdate) -> dict[str, object]:
    """保存复盘模型设置；未知模型返回 400。"""

    try:
        settings = await write_review_settings(
            ReviewSettings(
                model_id=body.modelId,
                enabled=body.enabled,
                min_complexity=body.minComplexity,
            )
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return settings.to_json()


@router.get("/review-artifacts")
async def get_review_artifacts(
    status: str | None = None,
    agentKind: str | None = None,
    limit: int = 50,
) -> dict[str, object]:
    """列出复盘产物（默认 pending，供审批门使用）。"""

    items = await list_review_artifacts(
        status=status,
        agent_kind=agentKind,
        limit=limit,
    )
    return {"items": items}


@router.post("/review-artifacts/{artifact_id}/approve")
async def approve_review_artifact(artifact_id: str) -> dict[str, object]:
    """批准一条复盘产物；含技能更新建议时自动落盘到 user 技能库。"""

    artifact = await get_review_artifact(artifact_id)
    if artifact is None:
        raise HTTPException(status_code=404, detail="复盘产物不存在")
    updated = await update_review_artifact_status(artifact_id, "approved")
    if not updated:
        raise HTTPException(status_code=404, detail="复盘产物不存在")
    applied: list[dict[str, object]] = []
    skill_updates = (artifact.get("output") or {}).get("skill_updates") or []
    if skill_updates:
        applied = apply_skill_updates(skill_updates)
        try:
            from backend.services.runtime.bootstrap import RUNTIME

            RUNTIME.reload_skills()
        except Exception:
            pass
    return {"ok": True, "appliedSkills": applied}


@router.post("/review-artifacts/{artifact_id}/reject")
async def reject_review_artifact(artifact_id: str) -> dict[str, object]:
    """驳回一条复盘产物。"""

    updated = await update_review_artifact_status(artifact_id, "rejected")
    if not updated:
        raise HTTPException(status_code=404, detail="复盘产物不存在")
    return {"ok": True}


@router.get("/session-search")
async def get_session_search(
    query: str = "",
    scopeId: str = "",
    limit: int = 20,
) -> dict[str, object]:
    """FTS5 优先 + LIKE 回退的会话/记忆检索。"""

    return await session_search(
        query=query,
        scope_ids=(scopeId,) if scopeId.strip() else (),
        limit=limit,
    )


@router.get("/review-stats")
async def get_review_stats() -> dict[str, object]:
    """复盘与记忆命中统计。"""

    artifacts = await list_review_artifacts(status=None, limit=200)
    by_status: dict[str, int] = {}
    facts = 0
    lessons = 0
    skills = 0
    for item in artifacts:
        status = str(item.get("status") or "unknown")
        by_status[status] = by_status.get(status, 0) + 1
        output = item.get("output") or {}
        facts += len(output.get("facts") or [])
        lessons += len(output.get("lessons") or [])
        skills += len(output.get("skill_updates") or [])
    memory = await memory_eval_stats()
    return {
        "artifacts": {
            "total": len(artifacts),
            "byStatus": by_status,
        },
        "knowledge": {"facts": facts, "lessons": lessons, "skillUpdates": skills},
        "memoryEval": memory,
    }
