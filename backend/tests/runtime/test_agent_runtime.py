"""统一 Agent Runtime 主流程测试。"""

from __future__ import annotations

from collections.abc import AsyncIterator
from pathlib import Path

import pytest

from backend.models.router import ModelSelection
from backend.runtime.agent_registry import AgentConfig, RegisteredAgent
from backend.runtime.agent_runtime import AgentRuntime
from backend.runtime.contracts import RuntimeContext, RuntimeMessage, RuntimeRequest
from backend.services.llm.credentials import LlmCredentials
from backend.skills.contracts import SkillDefinition


class FakeAgent:
    """用于验证 Runtime 编排的最小流式 Agent。"""

    agent_id = "fake"

    async def stream(
        self,
        *,
        request: RuntimeRequest,
        context: RuntimeContext,
        model: ModelSelection,
    ) -> AsyncIterator[str]:
        """确认上下文和模型已经由 Runtime 准备，然后返回两个事件。"""

        assert request.user_text == "执行测试"
        assert "必须测试" in context.rendered
        assert model.model_id == "auto"
        yield "event-1"
        yield "event-2"


class FakeAgentRegistry:
    """提供一个固定 Agent 注册项。"""

    def __init__(self) -> None:
        """创建测试 Agent 配置。"""

        config = AgentConfig(
            id="fake",
            name="Fake",
            adapter="fake",
            planner="test",
            skills=("test-skill",),
            tools=(),
            memory=("episodic",),
        )
        self.item = RegisteredAgent(config=config, adapter=FakeAgent())

    def load(self) -> None:
        """测试注册表不需要扫描磁盘。"""

    def get(self, agent_id: str) -> RegisteredAgent:
        """返回固定注册项。"""

        assert agent_id == "fake"
        return self.item

    def catalog(self) -> list[dict[str, object]]:
        """返回测试目录。"""

        return [{"id": "fake"}]


class FakeSkillRegistry:
    """提供固定系统 Skill。"""

    def __init__(self) -> None:
        """创建测试 Skill。"""

        self.skill = SkillDefinition(
            id="test-skill",
            name="Test",
            version="1.0.0",
            description="",
            scope="system",
            prompt="必须测试。",
            tools=(),
            memory=(),
            permissions={},
            requires_reasoning=False,
            source_path=Path("skill.yaml"),
        )

    def load(self) -> None:
        """测试注册表不需要扫描磁盘。"""

    def resolve(self, skill_ids: tuple[str, ...]) -> list[SkillDefinition]:
        """返回固定 Skill。"""

        assert skill_ids == ("test-skill",)
        return [self.skill]

    def catalog(self) -> list[dict[str, object]]:
        """返回测试 Skill 目录。"""

        return [{"id": "test-skill"}]


class FakeMemoryRouter:
    """避免 Runtime 测试访问真实数据库。"""

    def __init__(self) -> None:
        """初始化保存标记。"""

        self.saved = False

    async def search(self, **_: object) -> list[object]:
        """返回空 Memory。"""

        return []

    async def save_execution_summary(self, **_: object) -> object:
        """记录 Runtime 已尝试保存执行摘要。"""

        self.saved = True
        return object()


@pytest.mark.asyncio
async def test_agent_runtime_executes_unified_flow() -> None:
    """Runtime 应加载配置、构建上下文、选择模型并保存执行摘要。"""

    memory = FakeMemoryRouter()
    runtime = AgentRuntime(
        agent_registry=FakeAgentRegistry(),  # type: ignore[arg-type]
        skill_registry=FakeSkillRegistry(),  # type: ignore[arg-type]
        memory_router=memory,  # type: ignore[arg-type]
    )
    request = RuntimeRequest(
        agent_id="fake",
        payload=object(),
        preferred_model_id="auto",
        credentials=LlmCredentials({}),
        session_id="session",
        project_id="project",
        user_text="执行测试",
        messages=(RuntimeMessage("user", "执行测试"),),
    )

    events = await runtime.execute(request)

    assert events == ["event-1", "event-2"]
    assert memory.saved is True
