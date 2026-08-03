"""Context Manager 与 Model Router 测试。"""

from pathlib import Path

from backend.memory.contracts import MemoryRecord
from backend.models.router import ModelRouter
from backend.runtime.context import ContextManager
from backend.runtime.contracts import RuntimeMessage
from backend.skills.contracts import SkillDefinition


def test_context_manager_prioritizes_skill_and_respects_budget() -> None:
    """系统 Skill 应保留在上下文前部，并且结果不得超过预算。"""

    skill = SkillDefinition(
        id="test-skill",
        name="Test Skill",
        version="1.0.0",
        description="",
        scope="system",
        prompt="必须先读取真实文件。",
        tools=(),
        memory=(),
        permissions={},
        requires_reasoning=True,
        source_path=Path("skill.yaml"),
    )
    memory = MemoryRecord("mem-1", "task", "project", "当前任务：完成 Runtime 迁移。")
    messages = (
        RuntimeMessage("user", "请重构项目"),
        RuntimeMessage("assistant", "正在分析"),
    )

    context = ContextManager().build(
        messages=messages,
        memories=[memory],
        skills=[skill],
        token_budget=1_000,
    )

    assert context.rendered.startswith("## Skill · test-skill@1.0.0")
    assert "当前任务" in context.rendered
    assert len(context.rendered) <= 2_000
    assert context.estimated_tokens <= 1_000


def test_model_router_preserves_explicit_model() -> None:
    """Model Router 不得替换用户明确选择的模型 ID。"""

    selection = ModelRouter().select(
        preferred_model_id="custom-model",
        task_text="重构 Runtime 与 Checkpoint",
        context_tokens=10_000,
        requires_reasoning=True,
    )

    assert selection.model_id == "custom-model"
    assert selection.complexity == "complex"
