"""Skill 配置校验器。"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from backend.skills.contracts import SkillScope

SKILL_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,79}$")
VALID_SCOPES: set[str] = {"system", "project", "user", "task"}


class SkillValidator:
    """把外部 YAML 配置限制在 Runtime 可安全处理的范围内。"""

    def validate(self, raw: object, *, path: Path, scope: str) -> dict[str, Any]:
        """校验必填字段、标识符、权限和列表类型。"""

        if not isinstance(raw, dict):
            raise ValueError(f"Skill 配置必须是对象：{path}")
        if scope not in VALID_SCOPES:
            raise ValueError(f"Skill 目录层级无效：{scope}")

        identifier = str(raw.get("id") or raw.get("name") or "").strip().lower()
        if not SKILL_ID_PATTERN.fullmatch(identifier):
            raise ValueError(f"Skill ID 格式不正确：{identifier or path}")
        version = str(raw.get("version") or "").strip()
        if not version:
            raise ValueError(f"Skill 缺少 version：{path}")

        # permissions 必须是对象；未知字段保留给后续扩展，但不能接受列表或普通字符串。
        permissions = raw.get("permissions") or {}
        if not isinstance(permissions, dict):
            raise ValueError(f"Skill permissions 必须是对象：{path}")

        validated = dict(raw)
        validated["id"] = identifier
        validated["scope"] = scope
        validated["permissions"] = permissions
        validated["tools"] = self._string_list(raw.get("tools") or raw.get("required_tools"))
        validated["memory"] = self._string_list(raw.get("memory"))
        validated["tags"] = self._string_list(raw.get("tags"))
        return validated

    def _string_list(self, value: object) -> list[str]:
        """把可选 YAML 列表转换成去重字符串列表。"""

        if value is None:
            return []
        if not isinstance(value, list):
            raise ValueError("Skill 的 tools、memory 和 tags 必须是数组")
        cleaned = [str(item).strip() for item in value if str(item).strip()]
        return list(dict.fromkeys(cleaned))

    def cast_scope(self, value: str) -> SkillScope:
        """把已校验字符串转换成静态类型需要的 SkillScope。"""

        if value not in VALID_SCOPES:
            raise ValueError(f"未知 Skill Scope：{value}")
        return value  # type: ignore[return-value]
