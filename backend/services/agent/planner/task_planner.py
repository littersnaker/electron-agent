"""Code Agent 提示词优化、WorkList 建模与失败重规划。"""

from __future__ import annotations

import json
import logging
import os
import re
from dataclasses import dataclass, field
from typing import Any

from backend.services.agent.planner.plan_optimizer import optimize_work_granularity
from backend.services.agent.planner.planner_context import build_planner_prompt
from backend.services.agent.planner.target_preflight import is_greenfield_project
from backend.services.agent.shared.work_models import (
    FileSystemOperation,
    WorkItem,
    WorkLedger,
)
from backend.services.agent.worker.worklist_reviewer import review_worklist
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage, LlmUsage
from backend.services.software_factory.planning import enrich_software_factory_works

LOGGER = logging.getLogger(__name__)


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """读取整数环境变量并限制在安全区间。"""

    try:
        value = int(os.getenv(name, str(default)).strip())
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


# Planner 提示词中的数量上限统一走环境变量，避免改规划策略要动代码。
PLAN_MIN_WORKS = _env_int("CODE_AGENT_PLAN_MIN_WORKS", 3, 1, 12)
PLAN_MAX_WORKS = _env_int("CODE_AGENT_PLAN_MAX_WORKS", 8, 2, 24)
PLAN_TARGET_FILES_CAP = _env_int("CODE_AGENT_PLAN_TARGET_FILES_CAP", 15, 3, 60)


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
    review_notes: list[str] = field(default_factory=list)


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


def _derive_acceptance(objective: str) -> list[str]:
    """从 objective 派生 1-3 条短验收标准。

    精简后的 worklist 不再强制模型写 12 条验收；验收要点并入 objective，
    解析时空缺则按句子拆分派生，保证 worker 提示词里仍有验收依据。
    """

    text = (objective or "").strip()
    if not text:
        return []
    # 按中文/英文句子分隔符拆成候选句，取前 3 条作为验收标准。
    parts = [part.strip() for part in re.split(r"[。；;！？!\n]", text) if part.strip()]
    derived = [part[:120] for part in parts[:3]]
    if derived:
        return derived
    return [text[:120]]


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
        allowed_execution_types = {"agent", "coding", "filesystem", "validation", "artifact"}
        if execution_type not in allowed_execution_types:
            execution_type = "agent"
        if execution_type == "filesystem" and not file_operations:
            execution_type = "agent"
        if execution_type != "filesystem":
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
                acceptance_criteria=(
                    _strings(raw.get("acceptanceCriteria"), limit=12)
                    or _derive_acceptance(objective)
                ),
                dependencies=_strings(raw.get("dependencies"), limit=12),
                priority=_priority(raw.get("priority")),
                target_files=target_files,
                serial_group=str(raw.get("serialGroup") or "").strip()[:120],
                execution_type=execution_type,  # type: ignore[arg-type]
                file_operations=file_operations,
                validation_commands=_strings(raw.get("validationCommands"), limit=20),
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


def _enriched_fallback_plan(
    user_request: str,
    *,
    greenfield: bool = False,
) -> CodeTaskPlan:
    """在模型规划失败时仍补齐电商 Software Factory 工程链。"""

    plan = _fallback_plan(user_request)
    plan.works = optimize_work_granularity(user_request, plan.works)
    plan.works = enrich_software_factory_works(
        user_request,
        plan.works,
        greenfield=greenfield,
    )
    return plan


async def prepare_code_task(
    *,
    user_request: str,
    project_tree: str,
    initial_context: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
    candidate_files: list[str] | None = None,
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
  "worklist":[
    {"id":"W001","title":"短标题","objective":"独立目标，必须完整包含该 Work 的验收要点（如\"实现 X，要求滚动时 Y 生效\"）","targetFiles":["预计写入的相对路径"],"dependencies":["可选，只写真实产物前置的 Work id"]}
  ]
}
说明：executionType、priority、serialGroup、validationCommands 不需要你输出，系统会自动推导补全。文件重命名/移动类任务可额外输出 fileOperations。每个 Work 只输出上述最小字段，不要写多余的验收列表或验证命令，以节省输出。objective 必须写完整，把验收标准的关键要求合并进 objective。
规则：Work 应互不重复、边界清晰、依赖明确；不要按文件机械拆分。默认 3-6 个 Work，最多 8 个。
多文件功能域合并进同一个 Work，由 Worker 在内部分批 edit；只有文件完全不重叠、可独立验收的大模块才拆成独立 Work，不要为了并行而过度拆分。
单个 Work 的 targetFiles 控制在 15 个以内；涉及文件很多时按项目目录/路由/模块自然分组，每组不超过 15 个；存在共享基础（入口、主题、公共组件）时先做一个小的前置 Work，其余组互不依赖、可并行。不要所有页面塞进一个 Work，也不要按页面拆成几十个 Work。
“看看要不要补充/审计/完善”类请求：数据层审计与补齐合并为 1 个 Work（优先走本地校验快速通道），不要生成多个数据层 Work。
依赖只能表达真实产物前置关系，不能因为“先理解再开发”而把全部 Work 串成一条链。基础契约完成后，页面、购物车、订单等互不冲突模块应并行。
每个 coding Work 应控制在一个可独立验收的功能域，预计修改文件过多时拆分；不要把全部 Mock、类型、全局配置和所有页面塞进一个超大 W001。
每个 coding/artifact Work 必须填写 targetFiles（具体相对路径数组），禁止留空；批量直写依赖它。不要只填 src、app、pages 等宽泛目录；宽泛目录只表示影响范围，不应阻止其他模块并行。
priority 数字越小越先执行；互不依赖且 targetFiles/serialGroup 不冲突的 Work 会滚动并行，任一 Work 完成后立即补充新任务。会写同一具体文件或共享资源的 Work 必须填写相同 targetFiles/serialGroup，并用 priority 确定串行先后。
纯重命名、移动或删除空目录使用 filesystem；普通代码理解与修改使用 coding（兼容旧值 agent）；只执行质量命令使用 validation 并填写 validationCommands；生成可复用产物使用 artifact。filesystem 将由本地执行器完成，不调用 Worker 大模型。"""
    system = system.replace(
        "默认 3-6 个 Work，最多 8 个。",
        f"默认 {PLAN_MIN_WORKS} 个左右 Work，最多 {PLAN_MAX_WORKS} 个。",
    )
    system = system.replace(
        "单个 Work 的 targetFiles 控制在 15 个以内",
        f"单个 Work 的 targetFiles 控制在 {PLAN_TARGET_FILES_CAP} 个以内",
    )
    system = system.replace(
        "每组不超过 15 个",
        f"每组不超过 {PLAN_TARGET_FILES_CAP} 个",
    )
    if candidate_files:
        system += "\n\n" + (
            "内容检索到的项目相关候选文件（按匹配度排序，可能已存在，优先引用而不是新建）：\n"
            + "\n".join(f"- {path}" for path in candidate_files[:20])
            + "\ntargetFiles 应优先从这些候选文件中选择已存在的文件；"
            "只有确认该文件确实不存在时才新建并给出新路径。"
        )
    # Planner 只接收目标、项目元数据和相关文件摘要，不接收全仓库或完整历史。
    greenfield = is_greenfield_project(project_tree)
    if greenfield:
        system += "\n\n" + (
            "当前项目基本为空，这是从零构建请求。不要按页面拆成多个 Work："
            "只生成 1-3 个整站生成 Work。targetFiles 使用你将要创建的具体相对路径"
            "（允许文件尚不存在），禁止留空或只填目录；数据层走 artifact/factory "
            "确定性生成，页面层合并进单个 coding Work 一次性创建全部页面文件。"
        )
    prompt = build_planner_prompt(
        user_request=user_request,
        project_tree=project_tree,
        initial_context=initial_context,
    )
    try:
        text, usage, model = await GATEWAY.complete(
            preferred_model_id=preferred_model_id,
            credentials=credentials,
            messages=[LlmMessage("system", system), LlmMessage("user", prompt)],
            temperature=0.1,
            timeout_seconds=180,
            audit={"agentRole": "prompt_optimizer"},
        )
        raw = _extract_json(text)
        works = _parse_work_items(raw.get("worklist"))
        works = optimize_work_granularity(user_request, works)
        works = enrich_software_factory_works(
            user_request,
            works,
            greenfield=greenfield,
        )
        works, review_report = review_worklist(works)
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
        return PreparedTask(
            plan=plan,
            usage=usage,
            model_name=model.name,
            review_notes=review_report.adjustments,
        )
    except Exception as exc:
        # 兜底计划仍然返回给调度层，但失败原因必须可见，避免缺 Key/超时/
        # 供应商错误被误认为“计划优化成功”而误导后续排查。
        LOGGER.warning(
            "Planner LLM 规划失败，降级为单 Work 兜底计划：%s",
            str(exc)[:200],
        )
        return PreparedTask(
            plan=_enriched_fallback_plan(
                user_request,
                greenfield=greenfield,
            ),
            usage=LlmUsage(),
            model_name="",
            fallback_used=True,
        )


def _compact_replan_snapshot(ledger: WorkLedger) -> dict[str, Any]:
    """只保留重规划需要的 Work 字段，避免把历史错误和产物全文再次输入模型。"""

    snapshot = ledger.snapshot()
    return {
        "revision": ledger.revision,
        "reason": ledger.reason[:500],
        # 保留测试和诊断依赖的状态计数，但不携带完整产物与历史 transcript。
        "total": snapshot["total"],
        "succeeded": snapshot["succeeded"],
        "failed": snapshot["failed"],
        "pending": snapshot["pending"],
        "running": snapshot["running"],
        "skipped": snapshot["skipped"],
        "items": [
            {
                "id": item.id,
                "title": item.title,
                "objective": item.objective[:1_200],
                "status": item.status,
                "attempts": item.attempts,
                "dependencies": item.dependencies,
                "targetFiles": item.target_files[:30],
                "serialGroup": item.serial_group,
                "executionType": item.execution_type,
                "error": item.error[:1_500],
            }
            for item in ledger.items
        ],
    }


def _replacement_matches(failed: WorkItem, candidate: WorkItem) -> bool:
    """判断新增修复 Work 是否已经替代原失败 Work。"""

    failed_paths = {path.strip("/") for path in failed.target_files if path.strip("/")}
    candidate_paths = {path.strip("/") for path in candidate.target_files if path.strip("/")}
    if failed_paths.intersection(candidate_paths):
        return True
    if failed.serial_group and failed.serial_group == candidate.serial_group:
        return True
    failed_terms = set(re.findall(r"[A-Za-z0-9_\u4e00-\u9fff]{2,}", failed.title.lower()))
    candidate_text = f"{candidate.title} {candidate.objective}".lower()
    return sum(term in candidate_text for term in failed_terms) >= 2


async def replan_after_failures(
    *,
    plan: CodeTaskPlan,
    ledger: WorkLedger,
    failed_work_ids: list[str],
    failure_observation: str,
    failures: list[dict[str, object]] | None = None,
    preferred_model_id: str,
    credentials: LlmCredentials,
) -> ReplanResult:
    """把一个并行波次的完整成功/失败 JSON 一次性交给 Planner 重规划。"""

    system = """你是 Code Agent 的失败恢复 Planner。输入包含完整 WorkList JSON，其中 succeeded/skipped 工作已经落盘，绝不能重新规划、重做或改回 pending。
你只能调整 failed/pending 工作，必要时新增修复 Work。返回 JSON：
{
  "reason":"重规划原因",
  "retry":[{"id":"失败或待办 Work ID","title":"可选新标题","objective":"新执行策略","acceptanceCriteria":["标准"],"dependencies":["已完成或待办 ID"],"priority":100,"targetFiles":["路径"],"serialGroup":"可选","executionType":"coding","fileOperations":[{"type":"rename","sourcePath":"旧路径","targetPath":"新路径"}],"validationCommands":[]}],
  "newWorks":[{"id":"R001","title":"新增修复项","objective":"目标","acceptanceCriteria":["标准"],"dependencies":["ID"],"priority":100,"targetFiles":["路径"],"serialGroup":"可选","executionType":"coding","fileOperations":[],"validationCommands":[]}],
  "skip":["确认无需继续的 failed/pending ID"]
}
不要返回 succeeded/skipped ID 的更新；不要创建与成功 Work 重复的新 Work。
必须以 failureObservation 的真实错误为依据，不能仅因一个 Work 涉及 5 个左右文件就判定“范围过大”或擅自返工。
默认直接在 retry 中修正原失败 Work；只有原 Work 确实无法独立验收时才拆分。若拆成 newWorks，必须把被替代的原 Work 放入 skip，避免原 Work 与修复 Work 重复执行。
failures 数组逐条列出每个失败 Work 的原因、状态与失败类型。你必须逐条处理：
对每个 failed Work 决定 retry（修正原项）、skip（放弃）或 newWorks（拆分修复）；
不能因为某一个 Work 失败就重排或重做其它成功/待办 Work。
如果失败 Work 的目标文件已经存在且从错误信息看可能已满足验收标准，优先放入 skip，
避免重试时把已落盘的产物重复修改一遍。"""
    payload = {
        "taskSpec": json.loads(plan.to_prompt_json()),
        "failedWorkIds": failed_work_ids,
        "failureObservation": failure_observation[-12_000:],
        "failures": (failures or [])[:30],
        "fullWorkListSnapshot": _compact_replan_snapshot(ledger),
    }
    text, usage, model = await GATEWAY.complete(
        preferred_model_id=preferred_model_id,
        credentials=credentials,
        messages=[
            LlmMessage("system", system),
            LlmMessage("user", json.dumps(payload, ensure_ascii=False, indent=2)),
        ],
        temperature=0.1,
        timeout_seconds=120,
        audit={"agentRole": "task_planner"},
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
        if not failed:
            continue
        replacements = [
            item for item in new_items if _replacement_matches(failed, item)
        ]
        if replacements:
            # Planner 忘记填写 skip 时由后端兜底，防止原 Work 与拆分修复项同时返工。
            skipped_ids.append(failed.id)
            for replacement in replacements:
                replacement.dependencies = [
                    dependency
                    for dependency in replacement.dependencies
                    if dependency != failed.id
                ]
            continue
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
                validation_commands=failed.validation_commands,
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
