"""外部 Skill 安装 / 卸载 / 列表接口。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.services.runtime.bootstrap import RUNTIME
from backend.services.skills.installer import (
    install_skill,
    list_installed_skills,
    uninstall_skill,
)

router = APIRouter(tags=["skills"])


class InstallSkillRequest(BaseModel):
    """安装请求：SKILL.md 直链或 GitHub 仓库标识（owner/repo[/path]）。"""

    source: str = Field(min_length=1, max_length=2048)


@router.get("/api/skills")
async def get_installed_skills() -> dict[str, object]:
    """返回 SQLite 中已安装的外部 Skill 列表。"""

    return {"skills": await list_installed_skills()}


@router.post("/api/skills/install")
async def install_skill(payload: InstallSkillRequest) -> dict[str, object]:
    """从直链或 GitHub 仓库安装外部 Skill 并热加载到 Runtime。"""

    try:
        skill = await install_skill(payload.source)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # 网络 / 解析等外部错误统一转 400
        raise HTTPException(status_code=400, detail=f"Skill 安装失败：{exc}") from exc

    RUNTIME.reload_skills()
    return {"ok": True, "skill": skill}


@router.delete("/api/skills/{skill_id}")
async def remove_skill(skill_id: str) -> dict[str, object]:
    """卸载已安装的外部 Skill 并从 Runtime 移除。"""

    try:
        removed = await uninstall_skill(skill_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    RUNTIME.reload_skills()
    return {"ok": True, "removed": removed}
