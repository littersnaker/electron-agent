"""统一 Context Manager。"""

from __future__ import annotations

from typing import Any

from backend.services.memory.contracts import MemoryRecord
from backend.services.runtime.context.context_compressor import ContextCompressor, ContextSection
from backend.services.runtime.contracts import RuntimeContext, RuntimeMessage
from backend.services.skills.contracts import SkillDefinition

DEFAULT_TOKEN_BUDGET = 24_000
CHARACTERS_PER_TOKEN_BUDGET = 2


class ContextManager:
    """合并消息、Memory、Skill 和工具结果，并统一执行预算控制。"""

    def __init__(self, compressor: ContextCompressor | None = None) -> None:
        """保存可替换的压缩器，便于单元测试预算边界。"""

        self._compressor = compressor or ContextCompressor()

    def build(
        self,
        *,
        messages: tuple[RuntimeMessage, ...],
        memories: list[MemoryRecord],
        skills: list[SkillDefinition],
        tool_results: list[str] | None = None,
        token_budget: int = DEFAULT_TOKEN_BUDGET,
        metadata: dict[str, Any] | None = None,
    ) -> RuntimeContext:
        """构建一个可审计、受预算约束的 Runtime 上下文。"""

        safe_budget = max(1_000, min(token_budget, 128_000))
        sections: list[ContextSection] = []

        # System Skill 优先级最高，确保安全和工程约束不会被长历史挤出上下文。
        for skill in skills:
            sections.append(
                ContextSection(
                    name=f"Skill · {skill.id}@{skill.version}",
                    content=skill.prompt,
                    priority=self._skill_priority(skill.scope),
                )
            )

        # Task Memory 比普通历史更接近当前目标，因此放在聊天历史之前。
        for memory in memories:
            sections.append(
                ContextSection(
                    name=f"Memory · {memory.memory_type} · {memory.id}",
                    content=memory.content,
                    priority=self._memory_priority(memory.memory_type),
                )
            )

        history = self._render_history(messages)
        if history:
            sections.append(ContextSection("Conversation History", history, 50))

        # 工具结果来自真实环境，优先于普通聊天历史，但低于系统级安全 Skill。
        for index, result in enumerate(tool_results or [], start=1):
            sections.append(ContextSection(f"Tool Result {index}", result, 30))

        rendered, estimated_tokens = self._compressor.compress(
            sections,
            maximum_characters=safe_budget * CHARACTERS_PER_TOKEN_BUDGET,
        )
        return RuntimeContext(
            rendered=rendered,
            token_budget=safe_budget,
            estimated_tokens=estimated_tokens,
            skill_ids=tuple(skill.id for skill in skills),
            memory_ids=tuple(memory.id for memory in memories),
            metadata=dict(metadata or {}),
        )

    def _render_history(self, messages: tuple[RuntimeMessage, ...]) -> str:
        """把最近聊天消息转换成稳定文本，并避免重复空消息。"""

        lines: list[str] = []
        for message in messages[-40:]:
            content = message.content.strip()
            if not content:
                continue
            role = message.role.strip().upper() or "UNKNOWN"
            lines.append(f"[{role}]\n{content}")
        return "\n\n".join(lines)

    def _skill_priority(self, scope: str) -> int:
        """返回 Skill Scope 在上下文中的优先级数字。"""

        return {"system": 0, "project": 5, "user": 10, "task": 15}.get(scope, 20)

    def _memory_priority(self, memory_type: str) -> int:
        """返回不同 Memory 类型在上下文中的优先级。"""

        return {"task": 20, "semantic": 25, "episodic": 35}.get(memory_type, 40)
