"""控制 Code Agent 在什么情况下需要更高强度的结构化推理。"""

from __future__ import annotations

from backend.services.agent.runtime.reasoning_state import ReasoningLevel, ReasoningState
from backend.services.agent.shared.work_models import WorkItem

REASONING_BUDGET = {
    "simple": 1_000,
    "normal": 3_000,
    "complex": 8_000,
}

_COMPLEX_TERMS = {
    "架构",
    "迁移",
    "并发",
    "安全",
    "数据库",
    "契约",
    "重构",
    "runtime",
    "orchestrator",
    "planner",
}
_SIMPLE_TERMS = {"rename", "move", "文案", "注释", "拼写", "重命名", "移动"}


class ReasoningController:
    """按 Work 复杂度设置推理级别，并生成低 Token 的决策约束。"""

    def determine_level(self, work: WorkItem) -> ReasoningLevel:
        """根据文件数、依赖、重试次数和任务语义确定推理级别。"""

        searchable = f"{work.title} {work.objective}".lower()
        if work.execution_type == "filesystem" or (
            len(work.target_files) <= 1
            and not work.dependencies
            and any(term in searchable for term in _SIMPLE_TERMS)
        ):
            return "simple"
        complexity_score = (
            len(work.target_files)
            + len(work.dependencies) * 2
            + len(work.acceptance_criteria)
            + work.attempts * 2
        )
        if any(term in searchable for term in _COMPLEX_TERMS):
            complexity_score += 5
        if complexity_score >= 10:
            return "complex"
        return "normal"

    def prepare(self, work: WorkItem, state: ReasoningState | None = None) -> ReasoningState:
        """创建或刷新当前 Work 的结构化推理状态。"""

        level = self.determine_level(work)
        current = state or ReasoningState(work_id=work.id)
        current.work_id = work.id
        current.objective = work.objective
        current.level = level
        current.token_budget = REASONING_BUDGET[level]
        if not current.current_understanding:
            current.current_understanding = (
                f"只处理 {work.id}：{work.title}；需要以真实文件和工具结果为依据。"
            )
        if not current.hypothesis:
            current.hypothesis = "先定位最小修改面，再通过验证结果确认假设。"
        if not current.next_action:
            current.set_next_action("读取目标文件及直接依赖，确认最小修改位置。")
        if work.attempts > 1:
            current.add_risk(f"该 Work 已执行 {work.attempts} 次，必须避免重复失败方案。")
        return current

    def build_directive(self, state: ReasoningState) -> str:
        """把状态转换为下一轮模型可执行的简短约束，而不是冗长思维链。"""

        level_rules = {
            "simple": "直接执行最小改动，不展开无关方案。",
            "normal": "先说明问题判断、修改策略和验证方案，再选择一个工具动作。",
            "complex": "额外比较风险与备选方案，但本轮仍只执行一个最小步骤。",
        }
        return (
            "## STRUCTURED REASONING STATE\n"
            f"{state.render_summary()}\n"
            f"执行约束：{level_rules[state.level]}\n"
            "代码修改前必须能回答：为什么改、解决什么、影响哪里、如何验证、失败如何恢复。"
        )

    def should_reflect(self, action: str, *, failed: bool = False) -> bool:
        """判断当前动作结果是否值得触发反思，避免每次搜索都重复分析。"""

        return failed or action in {"edit", "run", "factory", "complete_work"}


__all__ = ["REASONING_BUDGET", "ReasoningController"]
