"""Agent 评测接口：数据集列表、发起跑分、查看结果。"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from backend.core.background import spawn
from backend.services.agent.evaluation.runner import (
    ensure_sample_datasets,
    load_datasets,
    run_evaluation,
)
from backend.services.llm.catalog import AUTO_MODEL_ID
from backend.services.llm.credentials import resolve_credentials
from backend.services.workspace.database import open_database

router = APIRouter(tags=["agent-evaluation"])


class EvaluationRunRequest(BaseModel):
    """发起一次 Agent 评测跑分。"""

    agent_id: str = Field(alias="agentId")
    dataset_name: str = Field(alias="datasetName")
    project_id: str = Field(default="", alias="projectId")


@router.get("/api/agent/evaluation/datasets")
async def get_evaluation_datasets() -> dict[str, object]:
    """列出本地评测数据集（无数据集时自动生成示例）。"""

    return {"datasets": load_datasets()}


@router.post("/api/agent/evaluation/datasets")
async def post_evaluation_dataset_seed() -> dict[str, object]:
    """主动生成示例数据集（空目录时兜底）。"""

    ensure_sample_datasets()
    return {"ok": True, "datasets": load_datasets()}


@router.post("/api/agent/evaluation/runs")
async def post_evaluation_run(
    body: EvaluationRunRequest, request: Request
) -> dict[str, object]:
    """按数据集发起评测跑分（后台执行，返回 runId）。"""

    datasets = load_datasets()
    dataset = next(
        (item for item in datasets if item["name"] == body.dataset_name), None
    )
    if dataset is None:
        raise HTTPException(status_code=404, detail="评测数据集不存在")
    try:
        payload = json.loads(Path(str(dataset["path"])).read_text("utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    cases = [case for case in (payload.get("cases") or []) if isinstance(case, dict)]
    if not cases:
        raise HTTPException(status_code=400, detail="数据集没有用例")

    preferred_model = request.headers.get("x-llm-model-id", AUTO_MODEL_ID).strip()
    credentials = resolve_credentials(request)
    session_id = f"eval-{body.agent_id}"

    run_id = f"eval_{uuid.uuid4().hex[:12]}"
    spawn(run_evaluation(
        agent_id=body.agent_id,
        dataset_name=body.dataset_name,
        cases=cases,
        credentials=credentials,
        preferred_model_id=preferred_model,
        project_id=body.project_id,
        session_id=session_id,
        run_id=run_id,
    ))
    return {"ok": True, "runId": run_id}


@router.get("/api/agent/evaluation/runs/{run_id}")
async def get_evaluation_run(run_id: str) -> dict[str, object]:
    """返回一轮评测的汇总与逐用例结果。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT * FROM eval_runs WHERE id = ?",
            (run_id,),
        )
        run = await cursor.fetchone()
        if not run:
            raise HTTPException(status_code=404, detail="评测运行不存在")
        case_cursor = await connection.execute(
            "SELECT * FROM eval_case_results WHERE run_id = ? ORDER BY case_index",
            (run_id,),
        )
        cases = await case_cursor.fetchall()
    return {
        "run": {
            "id": str(run["id"]),
            "agentId": str(run["agent_id"]),
            "datasetName": str(run["dataset_name"]),
            "totalCases": int(run["total_cases"]),
            "passed": int(run["passed"]),
            "avgDurationMs": int(run["avg_duration_ms"]),
            "totalTokens": int(run["total_tokens"]),
            "status": str(run["status"]),
            "errorMessage": str(run["error_message"]),
            "createdAt": str(run["created_at"]),
            "finishedAt": str(run["finished_at"]),
        },
        "cases": [
            {
                "caseIndex": int(row["case_index"]),
                "input": str(row["input"]),
                "expected": str(row["expected"]),
                "passed": bool(row["passed"]),
                "output": str(row["output"]),
                "durationMs": int(row["duration_ms"]),
                "tokens": int(row["tokens"]),
                "errorMessage": str(row["error_message"]),
            }
            for row in cases
        ],
    }
