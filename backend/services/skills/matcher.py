"""根据任务文本匹配可选 Skill 的简单规则。"""

from __future__ import annotations

from backend.skills.contracts import SkillDefinition


class SkillMatcher:
    """在 Agent 固定 Skill 之外，根据标签补充任务级能力。"""

    def match(
        self,
        *,
        task_text: str,
        candidates: list[SkillDefinition],
        limit: int = 3,
    ) -> list[SkillDefinition]:
        """按标签命中数量返回少量最相关 Skill。"""

        normalized = task_text.lower()
        scored: list[tuple[int, SkillDefinition]] = []
        for skill in candidates:
            score = sum(tag.lower() in normalized for tag in skill.tags)
            if score:
                scored.append((score, skill))

        # 分数相同情况下按 ID 排序，使不同操作系统上的结果一致。
        scored.sort(key=lambda item: (-item[0], item[1].id))
        return [skill for _, skill in scored[: max(0, limit)]]
