"""统一 Model Router。

现有 LLM Gateway 已经负责供应商可用性、端点回退和 Auto 候选排序。本模块位于其上层，
根据任务复杂度和 Skill 要求决定是否保留用户指定模型，并输出统一参数与可解释理由。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from backend.services.llm.catalog import AUTO_MODEL_ID


@dataclass(frozen=True, slots=True)
class ModelSelection:
    """保存 Model Router 的选择结果。"""

    model_id: str
    reason: str
    complexity: str
    parameters: dict[str, float] = field(default_factory=dict)


class ModelRouter:
    """根据任务文本、上下文大小和 Skill 要求选择模型策略。"""

    def select(
        self,
        *,
        preferred_model_id: str,
        task_text: str,
        context_tokens: int,
        requires_reasoning: bool,
    ) -> ModelSelection:
        """返回不破坏用户显式选择的模型路由结果。"""

        # 先估算复杂度；这一步只影响参数与诊断信息，不会偷偷替换用户明确指定的模型。
        complexity_score = self._complexity_score(
            task_text=task_text,
            context_tokens=context_tokens,
            requires_reasoning=requires_reasoning,
        )
        complexity = "complex" if complexity_score >= 3 else "simple"

        # 用户明确选择模型时必须原样保留，避免 Runtime 改写前端设置。
        normalized = preferred_model_id.strip() or AUTO_MODEL_ID
        if normalized != AUTO_MODEL_ID:
            return ModelSelection(
                model_id=normalized,
                reason="保留用户显式选择的模型，由 LLM Gateway 负责协议调用。",
                complexity=complexity,
                parameters={"temperature": 0.1},
            )

        # Auto 模式继续交给现有 Gateway 做供应商级可用性回退，Runtime 只声明任务复杂度。
        reason = (
            "复杂任务使用 Auto Router 的推理型候选与端点回退。"
            if complexity == "complex"
            else "简单任务使用 Auto Router 的快速可用候选。"
        )
        return ModelSelection(
            model_id=AUTO_MODEL_ID,
            reason=reason,
            complexity=complexity,
            parameters={"temperature": 0.1},
        )

    def _complexity_score(
        self,
        *,
        task_text: str,
        context_tokens: int,
        requires_reasoning: bool,
    ) -> int:
        """用可解释规则计算任务复杂度分数。"""

        score = 0
        normalized = task_text.lower()

        # 长上下文和长任务通常需要更强的规划与推理能力。
        if context_tokens >= 8_000:
            score += 2
        elif context_tokens >= 3_000:
            score += 1
        if len(task_text) >= 1_200:
            score += 1

        # 代码迁移、架构和多阶段任务比单文件解释更复杂。
        complex_terms = (
            "重构",
            "迁移",
            "架构",
            "并发",
            "checkpoint",
            "runtime",
            "refactor",
            "migration",
            "architecture",
        )
        if any(term in normalized for term in complex_terms):
            score += 1
        if requires_reasoning:
            score += 2
        return score
