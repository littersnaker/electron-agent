"""Skills 注册表与版本选择逻辑。"""

from __future__ import annotations

from pathlib import Path

from backend.services.skills.contracts import SkillDefinition
from backend.services.skills.loader import SkillLoader
from backend.services.skills.matcher import SkillMatcher

SCOPE_PRIORITY = {"system": 0, "project": 1, "user": 2, "task": 3}


class SkillRegistry:
    """扫描多个 Skill 根目录，并按优先级保存同名版本。"""

    def __init__(self, roots: dict[str, tuple[Path, ...]]) -> None:
        """保存按 scope 分类的 Skill 根目录。"""

        self._roots = roots
        self._loader = SkillLoader()
        self._matcher = SkillMatcher()
        self._skills: dict[str, list[SkillDefinition]] = {}

    def load(self) -> None:
        """扫描所有可用目录，并原子替换当前 Skill 注册表。"""

        loaded: dict[str, list[SkillDefinition]] = {}
        for scope in sorted(self._roots, key=lambda item: SCOPE_PRIORITY.get(item, 99)):
            for root in self._roots[scope]:
                if not root.is_dir():
                    continue
                for path in sorted(root.rglob("skill.yaml")):
                    skill = self._loader.load(path, scope=scope)
                    loaded.setdefault(skill.id, []).append(skill)

        # 同一 Skill ID 先按作用域优先级分组；同一作用域内高版本优先。
        # 不能直接按版本字符串排序，否则 ``1.10.0`` 会错误排在 ``1.9.0`` 前后。
        for versions in loaded.values():
            versions.sort(
                key=lambda item: (
                    SCOPE_PRIORITY[item.scope],
                    tuple(-part for part in self._version_key(item.version)),
                )
            )
        self._skills = loaded

    def resolve(self, skill_ids: tuple[str, ...]) -> list[SkillDefinition]:
        """按 Agent 配置顺序解析 Skill，并返回每个 ID 的最高优先级版本。"""

        resolved: list[SkillDefinition] = []
        for skill_id in skill_ids:
            versions = self._skills.get(skill_id)
            if not versions:
                raise KeyError(f"Agent 引用了未注册 Skill：{skill_id}")
            resolved.append(versions[0])
        return resolved


    def match(
        self,
        task_text: str,
        *,
        exclude_ids: tuple[str, ...] = (),
        limit: int = 2,
    ) -> list[SkillDefinition]:
        """根据任务标签补充少量动态 Skill，避免所有任务都注入完整能力集。"""

        excluded = set(exclude_ids)
        candidates = [
            versions[0]
            for identifier, versions in self._skills.items()
            if versions and identifier not in excluded
        ]
        return self._matcher.match(
            task_text=task_text,
            candidates=candidates,
            limit=limit,
        )

    def catalog(self) -> list[dict[str, object]]:
        """返回全部 Skill 版本的非敏感摘要。"""

        return [
            {
                "id": skill.id,
                "name": skill.name,
                "version": skill.version,
                "scope": skill.scope,
                "tools": list(skill.tools),
                "memory": list(skill.memory),
                "requiresReasoning": skill.requires_reasoning,
            }
            for versions in self._skills.values()
            for skill in versions
        ]

    def _version_key(self, version: str) -> tuple[int, ...]:
        """把常见点分版本转换成可比较数字元组。

        非数字后缀不会导致加载失败，而是按其中出现的数字进行稳定比较；完全没有数字时
        返回 ``(0,)``，兼容早期自定义版本文本。
        """

        parts: list[int] = []
        for segment in version.replace("-", ".").split("."):
            digits = "".join(character for character in segment if character.isdigit())
            parts.append(int(digits) if digits else 0)
        return tuple(parts or [0])

