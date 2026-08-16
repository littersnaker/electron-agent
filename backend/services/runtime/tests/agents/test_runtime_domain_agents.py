"""QA、Commerce Agent 适配器和应用级注册测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.schemas.commerce import CommerceRequest
from backend.services.agent.adapters.commerce import CommerceAgentAdapter
from backend.services.llm.credentials import LlmCredentials
from backend.services.models.router import ModelSelection
from backend.services.runtime.agent_registry import AgentRegistry
from backend.services.runtime.contracts import RuntimeContext, RuntimeRequest


@pytest.mark.asyncio
async def test_commerce_adapter_streams_listing_workflow() -> None:
    """Commerce Adapter 应根据 Runtime 元数据执行 Listing 子流程。"""

    adapter = CommerceAgentAdapter()
    request = RuntimeRequest(
        agent_id="commerce",
        payload=CommerceRequest(query="孕妇连衣裙"),
        preferred_model_id="auto",
        credentials={},
        session_id="commerce-session",
        project_id="",
        user_text="孕妇连衣裙",
        metadata={"workflow": "listing"},
    )
    context = RuntimeContext("", 10_000, 0)
    model = ModelSelection("auto", "test", "simple")

    events = [
        event
        async for event in adapter.stream(
            request=request,
            context=context,
            model=model,
        )
    ]

    assert any("COMMERCE_LISTING" in event for event in events)
    assert any('"progress": 100' in event for event in events)


def test_application_agent_registry_contains_qa_code_and_commerce() -> None:
    """应用级配置必须同时注册 QA、Code、Commerce、Media 与 Image 五类 Agent。"""

    project_root = Path(__file__).resolve().parents[5]
    registry = AgentRegistry(project_root / "agents")
    registry.load()

    assert registry.get("qa").adapter.agent_id == "qa"
    assert registry.get("coding").adapter.agent_id == "coding"
    assert registry.get("commerce").adapter.agent_id == "commerce"
    assert registry.get("media").adapter.agent_id == "media"
    assert registry.get("image").adapter.agent_id == "image"
    assert {item["id"] for item in registry.catalog()} == {
        "qa",
        "coding",
        "commerce",
        "media",
        "image",
    }


@pytest.mark.asyncio
async def test_commerce_adapter_rejects_llm_credentials_for_research() -> None:
    """市场研究必须使用 Commerce 数据源凭证，不能误用 LLM 凭证对象。"""

    adapter = CommerceAgentAdapter()
    request = RuntimeRequest(
        agent_id="commerce",
        payload=CommerceRequest(query="maternity dress"),
        preferred_model_id="auto",
        credentials=LlmCredentials({}),
        session_id="commerce-session",
        project_id="",
        user_text="maternity dress",
        metadata={"workflow": "research"},
    )
    context = RuntimeContext("", 10_000, 0)
    model = ModelSelection("auto", "test", "simple")

    with pytest.raises(TypeError, match="数据源凭证"):
        async for _ in adapter.stream(request=request, context=context, model=model):
            pass
