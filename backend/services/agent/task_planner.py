"""Code Agent 提示词优化、WorkList 建模与失败重规划。"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from backend.services.agent.work_models import (
    FileSystemOperation,
    WorkItem,
    WorkLedger,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage, LlmUsage


MAX_PLANNING_CONTEXT_CHARS = 90_000


@dataclass(slots=True)
class CodeTaskPlan:
    """由原始用户输入优化得到的可执行任务规格。"""

    raw_request: str
    optimized_prompt: str
    objective: str
    constraints: list[str]
    acceptance_criteria: list[str]
    non_goals: list[str]
    validation_commands: list[str]
    works: list[WorkItem]

    def to_prompt_json(self) -> str:
        """生成提供给执行 Agent 的紧凑任务规格 JSON。"""

        payload = {
            "optimizedPrompt": self.optimized_prompt,
            "objective": self.objective,
            "constraints": self.constraints,
            "acceptanceCriteria": self.acceptance_criteria,
            "nonGoals": self.non_goals,
            "validationCommands": self.validation_commands,
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)


@dataclass(slots=True)
class PreparedTask:
    """一次任务优化调用的结果与 Token 用量。"""

    plan: CodeTaskPlan
    usage: LlmUsage
    model_name: str
    fallback_used: bool = False


@dataclass(slots=True)
class ReplanResult:
    """失败后 Planner 对未完成工作项给出的调整。"""

    reason: str
    retry_items: list[WorkItem]
    new_items: list[WorkItem]
    skipped_ids: list[str]
    usage: LlmUsage
    model_name: str



def _extract_json(text: str) -> dict[str, Any]:
    """从模型回复提取 JSON 对象。"""

    stripped = text.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", stripped, re.IGNORECASE)
    candidate = fenced.group(1).strip() if fenced else stripped
    start, end = candidate.find("{"), candidate.rfind("}")
    if start < 0 or end < start:
        raise ValueError("Planner 没有返回 JSON")
    value = json.loads(candidate[start : end + 1])
    if not isinstance(value, dict):
        raise ValueError("Planner 响应必须是 JSON 对象")
    return value


def _strings(value: object, *, limit: int = 30) -> list[str]:
    """清洗模型返回的字符串数组。"""

    if not isinstance(value, list):
        return []
    return [str(item).strip()[:1000] for item in value if str(item).strip()][:limit]




def _priority(value: object) -> int:
    """容错解析 Planner 优先级，非数字时回退到默认值 100。"""

    try:
        return max(0, min(int(value or 100), 10_000))
    except (TypeError, ValueError):
        return 100


def _parse_file_operations(value: object) -> list[FileSystemOperation]:
    """解析 Planner 声明的确定性文件操作。"""

    if not isinstance(value, list):
        return []
    operations: list[FileSystemOperation] = []
    allowed = {"rename", "move", "delete_empty_dir"}
    for raw in value:
        if not isinstance(raw, dict):
            continue
        operation_type = str(raw.get("type") or "").strip().lower()
        source_path = str(
            raw.get("sourcePath") or raw.get("from") or raw.get("path") or ""
        ).strip()
        target_path = str(
            raw.get("targetPath") or raw.get("to") or ""
        ).strip()
        if operation_type not in allowed or not source_path:
            continue
        if operation_type in {"rename", "move"} and not target_path:
            continue
        operations.append(
            FileSystemOperation(
                type=operation_type,  # type: ignore[arg-type]
                source_path=source_path[:1000],
                target_path=target_path[:1000],
            )
        )
    return operations


def _parse_work_items(
    value: object,
    *,
    prefix: str = "W",
    allowed_dependency_ids: set[str] | None = None,
) -> list[WorkItem]:
    """解析并规范化 Planner 返回的工作项。"""

    if not isinstance(value, list):
        return []
    works: list[WorkItem] = []
    used_ids: set[str] = set()
    for index, raw in enumerate(value, start=1):
        if not isinstance(raw, dict):
            continue
        proposed_id = str(raw.get("id") or f"{prefix}{index:03d}").strip().upper()
        work_id = re.sub(r"[^A-Z0-9_-]", "", proposed_id)[:40] or f"{prefix}{index:03d}"
        if work_id in used_ids:
            work_id = f"{prefix}{index:03d}"
        used_ids.add(work_id)
        title = str(raw.get("title") or f"工作项 {index}").strip()[:200]
        objective = str(raw.get("objective") or title).strip()[:3000]
        file_operations = _parse_file_operations(raw.get("fileOperations"))
        execution_type = str(raw.get("executionType") or "agent").strip().lower()
        if execution_type != "filesystem" or not file_operations:
            execution_type = "agent"
            file_operations = []
        target_files = _strings(raw.get("targetFiles"), limit=200)
        for operation in file_operations:
            for path in (operation.source_path, operation.target_path):
                if path and path not in target_files:
                    target_files.append(path)
        works.append(
            WorkItem(
                id=work_id,
                title=title,
                objective=objective,
                acceptance_criteria=_strings(raw.get("acceptanceCriteria"), limit=12),
                dependencies=_strings(raw.get("dependencies"), limit=12),
                priority=_priority(raw.get("priority")),
                target_files=target_files,
                serial_group=str(raw.get("serialGroup") or "").strip()[:120],
                execution_type=execution_type,  # type: ignore[arg-type]
                file_operations=file_operations,
            )
        )
    valid_ids = {item.id for item in works}
    valid_ids.update(allowed_dependency_ids or set())
    for item in works:
        item.dependencies = [
            dependency
            for dependency in item.dependencies
            if dependency in valid_ids and dependency != item.id
        ]
    return works


def _fallback_plan(user_request: str) -> CodeTaskPlan:
    """模型规划无效时生成安全的单工作项计划。"""

    request = user_request.strip()
    return CodeTaskPlan(
        raw_request=request,
        optimized_prompt=request,
        objective=request[:2000] or "完成用户提出的代码修改",
        constraints=["先读取真实代码再修改", "不得泄露密钥或越出项目根目录"],
        acceptance_criteria=["实际文件修改符合用户要求", "修改后给出验证结果"],
        non_goals=[],
        validation_commands=[],
        works=[
            WorkItem(
                id="W001",
                title="完成代码修改",
                objective=request[:3000] or "完成用户提出的代码修改",
                acceptance_criteria=["完成所有必要文件修改并汇总结果"],
            )
        ],
    )


async def prepare_code_task(
    *,
    user_request: str,
    project_tree: str,
    initial_context: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
) -> PreparedTask:
    """把原始输入优化成执行规格和去重 WorkList。"""

    system = """你是 Code Agent 的任务规格优化器。把用户的口语需求补全为可执行代码任务，但不得改变用户明确给出的 model 值、Base URL、文件路径、命令、数字和禁止事项。
只返回 JSON：
{
  "optimizedPrompt":"可直接交给代码代理执行的完整指令",
  "objective":"单一总体目标",
  "constraints":["必须遵守的约束"],
  "acceptanceCriteria":["可验证的验收标准"],
  "nonGoals":["明确不做的内容"],
  "validationCommands":["建议的安全验证命令"],
  "worklist":[
    {"id":"W001","title":"短标题","objective":"独立目标","acceptanceCriteria":["标准"],"dependencies":[],"priority":100,"targetFiles":["预计写入的相对路径"],"serialGroup":"可选共享资源组","executionType":"agent","fileOperations":[{"type":"rename","sourcePath":"旧相对路径","targetPath":"新相对路径"}]}
  ]
}
规则：Work 应互不重复、边界清晰、依赖明确；不要按文件机械拆分；简单任务 1-3 个 Work；复杂任务按真实需要拆分，不设置 Work 数量硬上限。
priority 数字越小越先执行；互不依赖且 targetFiles/serialGroup 不冲突的 Work 会并行。会写同一文件或共享资源的 Work 必须填写相同 targetFiles/serialGroup，并用 priority 确定串行先后。
纯重命名、移动或删除空目录的 Work 必须设置 executionType=filesystem，并给出完整 fileOperations；这类 Work 将由 Python 本地执行器直接完成，不再调用 Worker 大模型。只有需要理解或修改文件内容时才使用 executionType=agent。"""
    prompt = (
        f"RAW USER REQUEST:\n{user_request}\n\n"
        f"PROJECT TREE:\n{project_tree[:30_000]}\n\n"
        f"INITIAL CONTEXT:\n{initial_context[:MAX_PLANNING_CONTEXT_CHARS]}"
    )
    try:
        text, usage, model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[LlmMessage("system", system), LlmMessage("user", prompt)],
            temperature=0.1,
        )
        raw = _extract_json(text)
        works = _parse_work_items(raw.get("worklist"))
        if not works:
            raise ValueError("Planner 没有生成有效 WorkList")
        plan = CodeTaskPlan(
            raw_request=user_request,
            optimized_prompt=str(raw.get("optimizedPrompt") or user_request).strip()[:20_000],
            objective=str(raw.get("objective") or user_request).strip()[:4000],
            constraints=_strings(raw.get("constraints")),
            acceptance_criteria=_strings(raw.get("acceptanceCriteria")),
            non_goals=_strings(raw.get("nonGoals")),
            validation_commands=_strings(raw.get("validationCommands"), limit=20),
            works=works,
        )
        return PreparedTask(plan=plan, usage=usage, model_name=model.name)
    except Exception:
        return PreparedTask(
            plan=_fallback_plan(user_request),
            usage=LlmUsage(),
            model_name="",
            fallback_used=True,
        )


async def replan_after_failures(
    *,
    plan: CodeTaskPlan,
    ledger: WorkLedger,
    failed_work_ids: list[str],
    failure_observation: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
) -> ReplanResult:
    """把一个并行波次的完整成功/失败 JSON 一次性交给 Planner 重规划。"""

    system = """你是 Code Agent 的失败恢复 Planner。输入包含完整 WorkList JSON，其中 succeeded/skipped 工作已经落盘，绝不能重新规划、重做或改回 pending。
你只能调整 failed/pending 工作，必要时新增修复 Work。返回 JSON：
{
  "reason":"重规划原因",
  "retry":[{"id":"失败或待办 Work ID","title":"可选新标题","objective":"新执行策略","acceptanceCriteria":["标准"],"dependencies":["已完成或待办 ID"],"priority":100,"targetFiles":["路径"],"serialGroup":"可选","executionType":"agent","fileOperations":[{"type":"rename","sourcePath":"旧路径","targetPath":"新路径"}]}],
  "newWorks":[{"id":"R001","title":"新增修复项","objective":"目标","acceptanceCriteria":["标准"],"dependencies":["ID"],"priority":100,"targetFiles":["路径"],"serialGroup":"可选","executionType":"agent","fileOperations":[]}],
  "skip":["确认无需继续的 failed/pending ID"]
}
不要返回 succeeded/skipped ID 的更新；不要创建与成功 Work 重复的新 Work。"""
    payload = {
        "taskSpec": json.loads(plan.to_prompt_json()),
        "failedWorkIds": failed_work_ids,
        "failureObservation": failure_observation[-60_000:],
        "fullWorkListSnapshot": ledger.snapshot(),
    }
    text, usage, model = await GATEWAY.complete(
        preferred_model_id=preferred_model_id,
        credentials=credentials,
        messages=[
            LlmMessage("system", system),
            LlmMessage("user", json.dumps(payload, ensure_ascii=False, indent=2)),
        ],
        temperature=0.1,
    )
    raw = _extract_json(text)
    existing_ids = {item.id for item in ledger.items}
    retry_items = _parse_work_items(
        raw.get("retry"),
        prefix="W",
        allowed_dependency_ids=existing_ids,
    )
    new_items = _parse_work_items(
        raw.get("newWorks"),
        prefix="R",
        allowed_dependency_ids=existing_ids,
    )
    skipped_ids = _strings(raw.get("skip"), limit=max(len(ledger.items) * 2, 100))
    handled = {item.id for item in retry_items}.union(skipped_ids)
    for failed_work_id in failed_work_ids:
        if failed_work_id in handled:
            continue
        failed = ledger.get(failed_work_id)
        if failed:
            retry_items.append(
                WorkItem(
                    id=failed.id,
                    title=failed.title,
                    objective=failed.objective,
                    acceptance_criteria=failed.acceptance_criteria,
                    dependencies=failed.dependencies,
                    priority=failed.priority,
                    target_files=failed.target_files,
                    serial_group=failed.serial_group,
                    execution_type=failed.execution_type,
                    file_operations=failed.file_operations,
                )
            )
    return ReplanResult(
        reason=str(raw.get("reason") or "根据失败结果调整未完成 Work").strip()[:3000],
        retry_items=retry_items,
        new_items=new_items,
        skipped_ids=skipped_ids,
        usage=usage,
        model_name=model.name,
    )


async def replan_after_failure(
    *,
    plan: CodeTaskPlan,
    ledger: WorkLedger,
    failed_work_id: str,
    failure_observation: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
) -> ReplanResult:
    """兼容旧调用方，把单个失败 Work 包装成并行波次重规划。"""

    return await replan_after_failures(
        plan=plan,
        ledger=ledger,
        failed_work_ids=[failed_work_id],
        failure_observation=failure_observation,
        preferred_model_id=preferred_model_id,
        credentials=credentials,
    )
