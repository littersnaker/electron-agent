"""根据任务文本匹配可用 Skill 的打分规则。"""

from __future__ import annotations

import re

from backend.services.skills.contracts import SkillDefinition

_STOP_WORDS = {
    "the", "and", "for", "with", "from", "that", "this", "your", "you",
    "use", "when", "what", "how", "are", "not", "can", "will", "into",
    "about", "have", "has", "its", "than", "then", "them", "they",
    "their", "there", "where", "which", "while", "should", "would", "could",
    "want", "need", "needs", "help", "using", "used", "make",
}


class SkillMatcher:
    """在 Agent 固定 Skill 之外，根据标签 / 名称 / 描述补充任务级能力。"""

    def match(
        self,
        *,
        task_text: str,
        candidates: list[SkillDefinition | dict[str, object]],
        limit: int = 3,
    ) -> list[SkillDefinition | dict[str, object]]:
        """按标签 / 名称 / 描述关键词打分，返回最相关的少量 Skill。

        - 名称精确命中：4 分；
        - 标签命中：每个 3 分；
        - 描述中的英文词或中文短句命中：每处 1-2 分。
        """

        normalized = task_text.lower()
        scored: list[tuple[int, SkillDefinition | dict[str, object]]] = []
        for item in candidates:
            score = self._score_item(item, normalized)
            if score:
                scored.append((score, item))

        # 分数相同情况下按 ID 排序，使不同操作系统上的结果一致。
        scored.sort(key=lambda entry: (-entry[0], self._item_id(entry[1])))
        return [item for _, item in scored[: max(0, limit)]]

    def _score_item(
        self,
        item: SkillDefinition | dict[str, object],
        normalized: str,
    ) -> int:
        """对单个候选 Skill 计算任务相关度得分。"""

        score = 0
        name = str(self._item_name(item)).strip().lower()
        name_variants = {name, name.replace("-", " "), name.replace("_", " ")}
        if name and any(variant in normalized for variant in name_variants):
            score += 4

        for tag in self._item_tags(item):
            tag_text = str(tag).strip().lower()
            if tag_text and tag_text in normalized:
                score += 3

        description = str(self._item_description(item)).lower()
        for word in re.findall(r"[a-z0-9][a-z0-9._-]{2,}", description):
            if word in normalized and word not in _STOP_WORDS:
                score += 1
        # 中文匹配：描述与任务文本取 4 字滑动窗口求交集，命中即加分。
        desc_chinese = re.sub(r"[^\u4e00-\u9fff]", "", description)
        task_chinese = re.sub(r"[^\u4e00-\u9fff]", "", normalized)
        if len(desc_chinese) >= 4 and len(task_chinese) >= 4:
            desc_pieces = {
                desc_chinese[i : i + 4]
                for i in range(len(desc_chinese) - 3)
            }
            task_pieces = {
                task_chinese[i : i + 4]
                for i in range(len(task_chinese) - 3)
            }
            if desc_pieces & task_pieces:
                score += 2
        return score

    def _item_id(self, item: SkillDefinition | dict[str, object]) -> str:
        """获取候选 Skill 的稳定排序 ID。"""

        if isinstance(item, SkillDefinition):
            return item.id
        return str(item.get("id") or item.get("name") or "")

    def _item_name(self, item: SkillDefinition | dict[str, object]) -> str:
        """获取候选 Skill 名称。"""

        if isinstance(item, SkillDefinition):
            return item.name
        return str(item.get("name") or item.get("id") or "")

    def _item_tags(
        self,
        item: SkillDefinition | dict[str, object],
    ) -> tuple[str, ...]:
        """获取候选 Skill 标签。"""

        if isinstance(item, SkillDefinition):
            return item.tags
        raw = item.get("tags") or ()
        return tuple(str(value) for value in raw)

    def _item_description(
        self,
        item: SkillDefinition | dict[str, object],
    ) -> str:
        """获取候选 Skill 描述。"""

        if isinstance(item, SkillDefinition):
            return item.description
        return str(item.get("description") or "")
