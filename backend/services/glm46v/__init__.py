"""GLM-4.6V-Flash 视觉 Skill 的项目内集成入口。"""

from backend.services.glm46v.enrichment import (
    enrich_runtime_context_with_glm46v,
    has_glm46v_image_work,
    has_image_attachments,
    strip_image_attachments,
)
from backend.services.glm46v.skill import (
    GLM46V_SKILL_ID,
    builtin_skill_catalog,
    resolve_builtin_skills,
    split_registry_and_builtin_skill_ids,
)

__all__ = [
    "GLM46V_SKILL_ID",
    "builtin_skill_catalog",
    "enrich_runtime_context_with_glm46v",
    "has_glm46v_image_work",
    "has_image_attachments",
    "resolve_builtin_skills",
    "split_registry_and_builtin_skill_ids",
    "strip_image_attachments",
]
