"""WorkList 计划细化失败降级测试。

计划细化（plan_screen）的 LLM 调用失败时（缺 Key / 超时 / 供应商错误），
任务应使用基础计划继续执行，而不是整个任务终止。
"""

from __future__ import annotations

import asyncio

import pytest

from backend.services.agent.plan_screen import refine_plan_works
from backend.services.agent.task_planner import CodeTaskPlan
from backend.services.agent.work_models import WorkItem
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.types import LlmUsage


def _plan() -> CodeTaskPlan:
    return CodeTaskPlan(
        raw_request="把固定尺寸改为 rpx",
        optimized_prompt="把固定尺寸改为 rpx",
        objective="移动端适配",
        constraints=["保持现有样式"],
        acceptance_criteria=["触控区不小于 88rpx"],
        non_goals=["不修改业务逻辑"],
        validation_commands=["pnpm lint"],
        works=[
            WorkItem(
                id="W001",
                title="分类页适配",
                objective="把分类页固定尺寸改为 rpx",
                target_files=["src/pages/category/index.scss"],
            ),
        ],
    )


def _anomalies() -> list[dict[str, object]]:
    return [
        {
            "workId": "W001",
            "reason": "targetFiles 全部不存在但检索到疑似已存在文件",
        }
    ]


@pytest.mark.asyncio
async def test_refine_plan_works_falls_back_on_gateway_error(monkeypatch) -> None:
    """GATEWAY 抛任意异常时，refine_plan_works 不抛错、不改 plan。"""

    from backend.services.agent import plan_screen as plan_screen_module

    async def _boom(**_: object) -> object:
        raise ValueError("已选择 DeepSeek flash-0731，但未配置 DeepSeek API Key。")

    monkeypatch.setattr(plan_screen_module.GATEWAY, "complete", _boom)
    plan = _plan()
    usage, model_name, applied = await refine_plan_works(
        plan,
        _anomalies(),
        "custom:deadbeef",
        LlmCredentials({}),
    )

    assert isinstance(usage, LlmUsage)
    assert usage.total == 0
    assert model_name == ""
    assert applied == []
    # 基础计划保持原样。
    assert plan.works[0].target_files == ["src/pages/category/index.scss"]


@pytest.mark.asyncio
async def test_refine_plan_works_falls_back_on_provider_error(monkeypatch) -> None:
    """供应商运行期错误同样降级，不终止任务。"""

    from backend.services.agent import plan_screen as plan_screen_module
    from backend.services.llm.protocols import ProviderRequestError

    async def _boom(**_: object) -> object:
        raise ProviderRequestError("provider unavailable")

    monkeypatch.setattr(plan_screen_module.GATEWAY, "complete", _boom)
    usage, model_name, applied = await refine_plan_works(
        _plan(),
        _anomalies(),
        "auto",
        LlmCredentials({}),
    )

    assert usage.total == 0
    assert applied == []


@pytest.mark.asyncio
async def test_refine_plan_works_falls_back_on_timeout(monkeypatch) -> None:
    """超时异常同样降级。"""

    from backend.services.agent import plan_screen as plan_screen_module

    async def _boom(**_: object) -> object:
        raise TimeoutError("model response timeout")

    monkeypatch.setattr(plan_screen_module.GATEWAY, "complete", _boom)
    usage, model_name, applied = await refine_plan_works(
        _plan(),
        _anomalies(),
        "auto",
        LlmCredentials({}),
    )

    assert usage.total == 0
    assert applied == []


def test_refine_plan_works_returns_early_without_anomalies() -> None:
    """无异常时零 LLM 调用，直接返回空结果。"""

    usage, model_name, applied = asyncio.run(
        refine_plan_works(_plan(), [], "auto", LlmCredentials({}))
    )

    assert usage.total == 0
    assert model_name == ""
    assert applied == []
