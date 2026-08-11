"""从目录中的 ``skill.yaml`` 和 ``prompt.md`` 加载 Skill。"""

from __future__ import annotations

from pathlib import Path

import yaml

from backend.skills.contracts import SkillDefinition
from backend.skills.validator import SkillValidator


class SkillLoader:
    """读取单个 Skill，并阻止提示词路径越出 Skill 目录。"""

    def __init__(self, validator: SkillValidator | None = None) -> None:
        """保存可替换的校验器，便于测试异常配置。"""

        self._validator = validator or SkillValidator()

    def load(self, path: Path, *, scope: str) -> SkillDefinition:
        """加载一个 ``skill.yaml`` 并返回完整 Skill 定义。"""

        resolved = path.resolve()
        raw = yaml.safe_load(resolved.read_text("utf-8"))
        config = self._validator.validate(raw, path=resolved, scope=scope)
        skill_root = resolved.parent

        # prompt 可以是内联文本，也可以是 Skill 目录内的 Markdown 文件名。
        prompt_value = config.get("prompt") or "prompt.md"
        prompt = self._load_prompt(skill_root, prompt_value)
        if not prompt.strip():
            raise ValueError(f"Skill Prompt 不能为空：{resolved}")

        return SkillDefinition(
            id=str(config["id"]),
            name=str(config.get("name") or config["id"]).strip(),
            version=str(config["version"]).strip(),
            description=str(config.get("description") or "").strip(),
            scope=self._validator.cast_scope(str(config["scope"])),
            prompt=prompt.strip(),
            tools=tuple(config["tools"]),
            memory=tuple(config["memory"]),
            permissions=dict(config["permissions"]),
            requires_reasoning=bool(config.get("requires_reasoning", False)),
            source_path=resolved,
            tags=tuple(config["tags"]),
            metadata=dict(config.get("metadata") or {}),
        )

    def _load_prompt(self, skill_root: Path, value: object) -> str:
        """读取内联提示词或 Skill 目录中的 Markdown 文件。"""

        if isinstance(value, dict):
            inline = str(value.get("inline") or "")
            file_name = str(value.get("file") or "").strip()
            if inline:
                return inline
            value = file_name or "prompt.md"

        candidate_text = str(value or "").strip()
        if "\n" in candidate_text:
            return candidate_text
        candidate = (skill_root / candidate_text).resolve()
        if skill_root not in candidate.parents and candidate != skill_root:
            raise ValueError(f"Skill Prompt 路径越出目录：{candidate_text}")
        if not candidate.is_file():
            # 没有对应文件时，将简短字符串视为内联 Prompt，兼容轻量配置。
            return candidate_text
        return candidate.read_text("utf-8")
