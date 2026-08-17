"""Agent 评测跑分测试：数据集加载、判定、逐用例跑分入库。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.core.config import get_settings
from backend.services.agent.evaluation.runner import (
    judge_case,
    load_datasets,
    run_evaluation,
)
from backend.services.workspace.database import initialize_database, open_database


def _isolated_db(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    get_settings.cache_clear()


def test_judge_case_substring() -> None:
    """默认判定：期望文本出现在输出中（不区分大小写）。"""

    assert judge_case("答案是 42 个", "42") is True
    assert judge_case("nothing here", "42") is False
    assert judge_case("", "") is False


def test_load_datasets_reads_json(tmp_path: Path, monkeypatch) -> None:
    """数据集目录下的 JSON 被扫描为可用数据集。"""

    _isolated_db(monkeypatch, tmp_path)
    directory = get_settings().data_dir / "evaluations"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "qa-basic.json").write_text(
        json.dumps(
            {
                "name": "qa-basic",
                "agentId": "qa",
                "cases": [{"input": "你好", "expected": "你好"}],
            }
        ),
        "utf-8",
    )
    datasets = load_datasets()
    assert len(datasets) == 1
    assert datasets[0]["name"] == "qa-basic"
    assert datasets[0]["agentId"] == "qa"
    assert datasets[0]["caseCount"] == 1


@pytest.mark.asyncio
async def test_run_evaluation_persists_results(
    tmp_path: Path, monkeypatch
) -> None:
    """跑分写入 eval_runs 与逐用例结果，指标汇总正确。"""

    _isolated_db(monkeypatch, tmp_path)
    await initialize_database()

    async def fake_runner(input_text: str) -> dict[str, object]:
        return {"output": f"收到：{input_text}", "tokens": 12}

    run_id = await run_evaluation(
        agent_id="qa",
        dataset_name="qa-basic",
        cases=[
            {"input": "你好", "expected": "你好"},
            {"input": "再见", "expected": "不存在"},
        ],
        credentials=None,
        preferred_model_id="auto",
        project_id="",
        session_id="eval-test",
        run_case=fake_runner,  # type: ignore[arg-type]
        run_id="eval_test_0001",
    )
    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT * FROM eval_runs WHERE id = ?", (run_id,)
        )
        run = await cursor.fetchone()
        case_cursor = await connection.execute(
            "SELECT passed, tokens FROM eval_case_results WHERE run_id = ? "
            "ORDER BY case_index",
            (run_id,),
        )
        cases = await case_cursor.fetchall()
    assert run is not None
    assert run["passed"] == 1
    assert run["total_cases"] == 2
    assert run["total_tokens"] == 24
    assert run["status"] == "completed"
    assert [row["passed"] for row in cases] == [1, 0]
