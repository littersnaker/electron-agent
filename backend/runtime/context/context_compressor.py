"""Runtime 上下文压缩器。

压缩器不调用模型，而是通过去重、优先级和字符预算保证上下文大小可控。这样即使模型服务
暂时不可用，Runtime 仍能稳定构建请求，不会因为历史无限增长而失败。
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ContextSection:
    """表示一段可独立排序和截断的上下文。"""

    name: str
    content: str
    priority: int


class ContextCompressor:
    """按优先级去重并压缩上下文段落。"""

    def compress(
        self,
        sections: list[ContextSection],
        *,
        maximum_characters: int,
    ) -> tuple[str, int]:
        """返回压缩后的文本和粗略 Token 数。"""

        if maximum_characters <= 0:
            return "", 0

        unique = self._deduplicate(sections)
        ordered = sorted(unique, key=lambda item: (item.priority, item.name))
        rendered: list[str] = []
        consumed = 0

        for section in ordered:
            # 每一段都带显式标题，便于模型区分 Skill、Memory、历史和工具结果。
            prefix = f"## {section.name}\n"
            remaining = maximum_characters - consumed
            if remaining <= len(prefix):
                break
            allowed_content = remaining - len(prefix)
            content = section.content[:allowed_content]
            if not content:
                continue
            suffix = "\n（本段已按上下文预算截断）" if len(content) < len(section.content) else ""
            block = f"{prefix}{content}{suffix}"
            rendered.append(block)
            consumed += len(block) + 2

        result = "\n\n".join(rendered)
        return result, self.estimate_tokens(result)

    def estimate_tokens(self, text: str) -> int:
        """使用保守字符比例估算中英文混合文本的 Token 数。"""

        if not text:
            return 0
        # 中文通常接近一字一 Token，英文通常约四字符一 Token；除以 2 是较保守的混合估计。
        return max(1, (len(text) + 1) // 2)

    def _deduplicate(self, sections: list[ContextSection]) -> list[ContextSection]:
        """删除完全相同或仅空白差异的上下文段。"""

        seen: set[str] = set()
        result: list[ContextSection] = []
        for section in sections:
            normalized = " ".join(section.content.split())
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            result.append(section)
        return result
