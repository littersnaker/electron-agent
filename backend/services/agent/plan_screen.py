"""WorkList 内容筛查与 LLM 细分。

Planner 可能因幻觉把已存在文件分配成空 targetFiles 或不存在路径。此模块在 Planner
之后做一次确定性筛查：只有发现“空 targetFiles”或“目标全部不存在但内容检索找到
疑似已存在文件”时，才把筛查结果交给 LLM 做最后一轮细分，成本受控（无异常零调用）。
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

from backend.services.agent.task_planner import CodeTaskPlan
from backend.services.agent.work_models import WorkItem
from backend.services.agent.workspace_tools import score_workspace_paths
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage, LlmUsage
from backend.utils.paths import resolve_inside

LOGGER = logging.getLogger(__name__)

MAX_SCREEN_WORKS = 16
MAX_CANDIDATES_PER_WORK = 8

_REFINE_SYSTEM = """你是 WorkList 细分器。内容筛查发现部分 Work 的 targetFiles 为空或指向不存在的文件，
同时内容检索找到了可能已存在的目标文件。请修正这些 Work 的 targetFiles：
- 候选文件若明显属于该 Work 的功能（说明文件已存在），把 targetFiles 改为这些已存在文件，
  禁止把已存在文件再当新建文件重复创建；
- 若该 Work 确实在创建新功能（候选文件与功能无关），保留原新建路径；
- 其余未提及的 Work 不要改动。
只返回 JSON：{"works":[{"id":"W001","targetFiles":["相对路径"]}]}
只包含需要修正 targetFiles 的 Work，不要返回其他字段。"""


def _path_exists(root: Path, relative: str) -> bool:
    """安全判断相对路径是否已存在。"""

    try:
        return resolve_inside(root, relative).is_file()
    except ValueError:
        return False


def screen_plan_anomalies(
    root: Path,
    works: list[WorkItem],
    *,
    limit: int = MAX_SCREEN_WORKS,
) -> list[dict[str, Any]]:
    """对 Planner 生成的 WorkList 做内容级筛查，返回可疑 Work 清单。

    只筛查 coding/agent 类 Work；有真实目标文件存在的 Work 直接跳过，
    避免对大项目做无谓的全文扫描。
    """

    anomalies: list[dict[str, Any]] = []
    for work in works:
        if work.execution_type not in {"coding", "agent"}:
            continue
        if len(anomalies) >= limit:
            break
        targets = [path for path in work.target_files if path.strip()]
        if targets and any(_path_exists(root, path) for path in targets):
            continue
        search_text = " ".join(
            [work.title, work.objective, *work.acceptance_criteria]
        )
        candidates = score_workspace_paths(
            root,
            search_text,
            limit=MAX_CANDIDATES_PER_WORK,
        )
        if not candidates:
            continue
        anomalies.append(
            {
                "workId": work.id,
                "reason": "empty_targets" if not targets else "missing_targets",
                "declared": targets,
                "candidates": candidates,
            }
        )
    return anomalies


def _extract_json_object(text: str) -> dict[str, Any]:
    """提取首个完整 JSON 对象。"""

    start = text.find("{")
    if start < 0:
        raise ValueError("细分器没有返回 JSON 对象")
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        character = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                value = json.loads(text[start : index + 1])
                if not isinstance(value, dict):
                    raise ValueError("细分器返回的不是 JSON 对象")
                return value
    raise ValueError("细分器返回的 JSON 未闭合")


def _clean_paths(value: object) -> list[str]:
    """把细分器返回的 targetFiles 清洗为去重相对路径。"""

    if isinstance(value, str):
        raw = re.split(r"[,，\n]+", value)
    elif isinstance(value, list):
        raw = value
    else:
        return []
    paths: list[str] = []
    for item in raw:
        cleaned = str(item or "").strip().replace("\\", "/").lstrip("./")
        if cleaned and cleaned not in paths:
            paths.append(cleaned)
    return paths


async def refine_plan_works(
    plan: CodeTaskPlan,
    anomalies: list[dict[str, Any]],
    preferred_model_id: str,
    credentials: LlmCredentials,
) -> tuple[LlmUsage, str, list[str]]:
    """把筛查结果交给 LLM 做最后一轮 targetFiles 细分，直接修改 plan.works。"""

    if not anomalies:
        return LlmUsage(), "", []
    worklist = [
        {
            "id": work.id,
            "title": work.title,
            "objective": work.objective,
            "targetFiles": work.target_files,
        }
        for work in plan.works
    ]
    user = json.dumps(
        {"currentWorklist": worklist, "anomalies": anomalies},
        ensure_ascii=False,
    )
    try:
        text, usage, model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[
                LlmMessage("system", _REFINE_SYSTEM),
                LlmMessage("user", user),
            ],
            temperature=0.1,
            timeout_seconds=120,
            audit={"agentRole": "plan_screen"},
        )
    except Exception as exc:
        # 计划细化失败不终止任务：保留基础计划继续执行，异常信息交给调用方提示。
        LOGGER.warning("WorkList 计划细化失败，使用基础计划继续：%s", exc)
        return LlmUsage(), "", []
    by_id = {work.id: work for work in plan.works}
    applied: list[str] = []
    try:
        payload = _extract_json_object(text)
    except (ValueError, json.JSONDecodeError):
        return usage, model.name, []
    for entry in payload.get("works") or []:
        if not isinstance(entry, dict):
            continue
        work_id = str(entry.get("id") or "").strip().upper()
        work = by_id.get(work_id)
        if work is None:
            continue
        paths = _clean_paths(entry.get("targetFiles"))
        if not paths:
            continue
        work.target_files = paths
        applied.append(work_id)
    return usage, model.name, applied


__all__ = [
    "refine_plan_works",
    "screen_plan_anomalies",
]
