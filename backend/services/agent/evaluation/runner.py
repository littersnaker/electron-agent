"""Agent 评测跑分：数据集 → 逐用例调 Agent → 判定 → 汇总入库。

数据集放在 ``<data_dir>/evaluations/*.json``，结构：
``{"name": "...", "agentId": "qa", "cases": [{"input": "...", "expected": "...", "judgePrompt": "..."}]}``。
默认按"期望文本子串"判定；提供 ``judgePrompt`` 时改用 LLM 判定。
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Awaitable, Callable
from uuid import uuid4

from backend.core.config import get_settings
from backend.schemas.chat import ChatRequest, FrontendMessage
from backend.services.workspace.database import open_database, utc_now_iso

CaseRunner = Callable[[str], Awaitable[dict[str, Any]]]


def evaluations_directory() -> Path:
    """返回评测数据集目录并确保存在。"""

    directory = get_settings().data_dir / "evaluations"
    directory.mkdir(parents=True, exist_ok=True)
    return directory


_SAMPLE_DATASET: dict[str, Any] = {
    "name": "sample-qa",
    "agentId": "qa",
    "cases": [
        {"input": "你好，请介绍一下你自己", "expected": "你好"},
        {"input": "1 + 1 等于几？", "expected": "2"},
    ],
}


def ensure_sample_datasets() -> None:
    """评测目录没有任何数据集时生成一个示例数据集，避免页面空转。"""

    directory = evaluations_directory()
    if any(directory.glob("*.json")):
        return
    target = directory / "sample-qa.json"
    target.write_text(
        json.dumps(_SAMPLE_DATASET, ensure_ascii=False, indent=2),
        "utf-8",
    )


def load_datasets() -> list[dict[str, Any]]:
    """读取全部评测数据集（按文件名字典序）。"""

    ensure_sample_datasets()
    datasets: list[dict[str, Any]] = []
    for path in sorted(evaluations_directory().glob("*.json")):
        try:
            payload = json.loads(path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(payload, dict):
            continue
        cases = payload.get("cases") or []
        if isinstance(cases, list) and cases:
            datasets.append(
                {
                    "name": str(payload.get("name") or path.stem),
                    "agentId": str(payload.get("agentId") or ""),
                    "caseCount": len(cases),
                    "path": str(path),
                }
            )
    return datasets


def judge_case(output: str, expected: str) -> bool:
    """默认判定：期望文本（不区分大小写）出现在输出中。"""

    needle = (expected or "").strip().lower()
    return bool(needle and needle in (output or "").lower())


async def judge_case_with_llm(
    output: str,
    expected: str,
    judge_prompt: str,
    *,
    credentials: object,
    preferred_model_id: str,
) -> bool:
    """可选 LLM 判定：把输出与期望交给模型，返回 PASS/FAIL。"""

    from backend.services.llm.gateway import GATEWAY
    from backend.services.llm.types import LlmMessage

    text, _usage, _model = await GATEWAY.complete(
        preferred_model_id=preferred_model_id,
        credentials=credentials,
        messages=[
            LlmMessage(
                "system",
                "你是评测裁判。根据期望与判定标准，回答 PASS 或 FAIL，不要解释。",
            ),
            LlmMessage(
                "user",
                f"期望：{expected}\n判定标准：{judge_prompt}\n\nAgent 输出：\n{output[:6000]}",
            ),
        ],
        temperature=0.0,
        timeout_seconds=60,
    )
    return "PASS" in text.strip().upper()[:8]


def default_case_runner(
    *,
    agent_id: str,
    credentials: object,
    preferred_model_id: str,
    project_id: str,
    session_id: str,
) -> CaseRunner:
    """默认执行器：构造 ChatRequest 并调用统一 Runtime 收集 SSE 帧。"""

    from backend.services.runtime.bootstrap import RUNTIME
    from backend.services.runtime.contracts import RuntimeRequest

    async def run(input_text: str) -> dict[str, Any]:
        payload = ChatRequest(
            messages=[FrontendMessage(role="user", content=input_text)],
            session_id=session_id,
            project_id=project_id,
        )
        request = RuntimeRequest(
            agent_id=agent_id,
            payload=payload,
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            session_id=session_id,
            project_id=project_id,
            user_text=input_text,
            messages=(),
        )
        frames: list[str] = []
        async for frame in RUNTIME.execute_stream(request):
            if isinstance(frame, str):
                frames.append(frame)
        return {"output": "\n".join(frames)[:12000], "tokens": 0}

    return run


async def run_evaluation(
    *,
    agent_id: str,
    dataset_name: str,
    cases: list[dict[str, Any]],
    credentials: object,
    preferred_model_id: str,
    project_id: str,
    session_id: str,
    run_case: CaseRunner | None = None,
    run_id: str | None = None,
) -> str:
    """执行一次评测：逐用例跑分并入库，返回 run_id。"""

    run_id = run_id or f"eval_{uuid4().hex[:12]}"
    runner = run_case or default_case_runner(
        agent_id=agent_id,
        credentials=credentials,
        preferred_model_id=preferred_model_id,
        project_id=project_id,
        session_id=session_id,
    )
    now = utc_now_iso()
    async with open_database() as connection:
        await connection.execute(
            "INSERT INTO eval_runs "
            "(id, agent_id, dataset_name, total_cases, passed, avg_duration_ms, "
            " total_tokens, status, error_message, created_at, finished_at) "
            "VALUES (?, ?, ?, ?, 0, 0, 0, 'running', '', ?, '')",
            (run_id, agent_id, dataset_name, len(cases), now),
        )

    passed = 0
    durations: list[int] = []
    total_tokens = 0
    error_message = ""
    for index, case in enumerate(cases):
        input_text = str(case.get("input") or "")
        expected = str(case.get("expected") or "")
        judge_prompt = str(case.get("judgePrompt") or case.get("judge_prompt") or "")
        started = time.monotonic()
        output = ""
        tokens = 0
        case_error = ""
        ok = False
        try:
            result = await runner(input_text)
            output = str(result.get("output") or "")
            tokens = int(result.get("tokens") or 0)
            if judge_prompt:
                ok = await judge_case_with_llm(
                    output,
                    expected,
                    judge_prompt,
                    credentials=credentials,
                    preferred_model_id=preferred_model_id,
                )
            else:
                ok = judge_case(output, expected)
        except Exception as exc:  # noqa: BLE001 - 单用例失败不中断整轮
            case_error = str(exc)[:500]
        duration_ms = max(0, round((time.monotonic() - started) * 1000))
        durations.append(duration_ms)
        total_tokens += tokens
        if ok:
            passed += 1
        async with open_database() as connection:
            await connection.execute(
                "INSERT INTO eval_case_results "
                "(run_id, case_index, input, expected, passed, output, "
                " duration_ms, tokens, error_message, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    run_id,
                    index,
                    input_text[:2000],
                    expected[:500],
                    1 if ok else 0,
                    output[:6000],
                    duration_ms,
                    tokens,
                    case_error,
                    utc_now_iso(),
                ),
            )

    avg_duration = round(sum(durations) / len(durations)) if durations else 0
    async with open_database() as connection:
        await connection.execute(
            "UPDATE eval_runs SET passed = ?, avg_duration_ms = ?, "
            "total_tokens = ?, status = 'completed', finished_at = ?, "
            "error_message = ? WHERE id = ?",
            (passed, avg_duration, total_tokens, utc_now_iso(), error_message, run_id),
        )
    return run_id


__all__ = [
    "default_case_runner",
    "ensure_sample_datasets",
    "evaluations_directory",
    "judge_case",
    "judge_case_with_llm",
    "load_datasets",
    "run_evaluation",
]
