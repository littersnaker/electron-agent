"""WorkList 内容筛查与 LLM 细分测试。"""

from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from backend.services.agent.plan_screen import (
    refine_plan_works,
    screen_plan_anomalies,
)
from backend.services.agent.task_planner import CodeTaskPlan
from backend.services.agent.work_models import WorkItem
from backend.services.agent.workspace_tools import score_workspace_paths
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.types import LlmUsage


def _plan(*works: WorkItem) -> CodeTaskPlan:
    return CodeTaskPlan(
        raw_request="完成代码修改",
        optimized_prompt="完成代码修改",
        objective="完成代码修改",
        constraints=[],
        acceptance_criteria=[],
        non_goals=[],
        validation_commands=[],
        works=list(works),
    )


def test_score_workspace_paths_matches_chinese_query_to_english_file(
    tmp_path,
) -> None:
    """中文请求应能通过文件内容命中英文命名的相关文件。"""

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "CartPage.tsx").write_text(
        "// 购物车页面\nconst title = '购物车';\n",
        "utf-8",
    )
    (tmp_path / "src" / "HomePage.tsx").write_text(
        "const title = '首页';\n",
        "utf-8",
    )

    hits = score_workspace_paths(tmp_path, "购物车页面开发", limit=4)

    assert hits
    assert hits[0] == "src/CartPage.tsx"


def test_screen_plan_anomalies_flags_empty_targets_with_existing_match(
    tmp_path,
) -> None:
    """Planner 把已存在文件分配成空 targetFiles 时应被筛查捕获。"""

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "CartPage.tsx").write_text(
        "// 购物车页面\nconst title = '购物车';\n",
        "utf-8",
    )
    work = WorkItem("W001", "购物车页开发", "开发购物车页面")

    anomalies = screen_plan_anomalies(tmp_path, [work])

    assert len(anomalies) == 1
    assert anomalies[0]["workId"] == "W001"
    assert anomalies[0]["reason"] == "empty_targets"
    assert "src/CartPage.tsx" in anomalies[0]["candidates"]


def test_screen_plan_anomalies_skips_works_with_existing_targets(tmp_path) -> None:
    """已有真实目标文件的 Work 不应进入筛查（避免大项目全文扫描）。"""

    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "CartPage.tsx").write_text(
        "// 购物车页面\nconst title = '购物车';\n",
        "utf-8",
    )
    work = WorkItem(
        "W001",
        "购物车页开发",
        "开发购物车页面",
        target_files=["src/CartPage.tsx"],
    )

    assert screen_plan_anomalies(tmp_path, [work]) == []


@pytest.mark.asyncio
async def test_refine_plan_works_applies_llm_target_files(monkeypatch) -> None:
    """细分器返回的 targetFiles 应应用到对应 Work 并记录审查说明。"""

    work = WorkItem("W001", "购物车页开发", "开发购物车页面")
    plan = _plan(work)
    anomalies = [
        {
            "workId": "W001",
            "reason": "empty_targets",
            "declared": [],
            "candidates": ["src/CartPage.tsx"],
        }
    ]

    async def fake_complete(**_kwargs):
        return (
            json.dumps(
                {"works": [{"id": "W001", "targetFiles": ["src/CartPage.tsx"]}]},
                ensure_ascii=False,
            ),
            LlmUsage(prompt=10, completion=5, total=15),
            SimpleNamespace(name="Screen Model"),
        )

    monkeypatch.setattr(
        "backend.services.agent.plan_screen.GATEWAY.complete",
        fake_complete,
    )

    usage, model_name, applied_ids = await refine_plan_works(
        plan,
        anomalies,
        "auto",
        LlmCredentials(values={}),
    )

    assert work.target_files == ["src/CartPage.tsx"]
    assert applied_ids == ["W001"]
    assert usage.total == 15
    assert model_name == "Screen Model"


@pytest.mark.asyncio
async def test_refine_plan_works_skips_when_no_anomalies() -> None:
    """无异常时不应产生任何 LLM 调用。"""

    plan = _plan(WorkItem("W001", "购物车页开发", "开发购物车页面"))

    usage, model_name, applied_ids = await refine_plan_works(
        plan,
        [],
        "auto",
        LlmCredentials(values={}),
    )

    assert usage.total == 0
    assert model_name == ""
    assert applied_ids == []
