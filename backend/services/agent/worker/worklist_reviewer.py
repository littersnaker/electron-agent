"""WorkList 确定性审查与再分配。

Planner 生成 WorkList 后、进入调度前执行：结构审查（依赖环/无效依赖/重复文件）、
容量拆分（超大 Work 按文件数切分）、执行类型再分配（factory/validation）、
敏感路径过滤。全部为纯代码逻辑，不调用模型，任何项目类型通用。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from backend.services.agent.shared.domain_rules import worklist_reviewer_rules
from backend.services.agent.shared.work_models import WorkItem
from backend.services.agent.worker.work_router import is_factory_audit_work
from backend.services.agent.worker.worklist_normalizer import (
    MAX_WORK_TARGET_FILES,
    split_oversized_works,
)
from backend.utils.paths import is_build_output_path
from backend.utils.sensitive_paths import is_sensitive_workspace_path

FACTORY_GENERATE_TERMS = tuple(
    str(item)
    for item in worklist_reviewer_rules().get("factoryGenerateTerms") or ()
)
GENERATE_TERMS = tuple(
    str(item)
    for item in worklist_reviewer_rules().get("generateTerms") or ()
)
PAGE_INTENT_TERMS = tuple(
    str(item)
    for item in worklist_reviewer_rules().get("pageIntentTerms") or ()
)
VALIDATION_ONLY_TERMS = tuple(
    str(item)
    for item in worklist_reviewer_rules().get("validationOnlyTerms") or ()
)
EDIT_INTENT_TERMS = tuple(
    str(item)
    for item in worklist_reviewer_rules().get("editIntentTerms") or ()
)


@dataclass(slots=True)
class WorklistReviewReport:
    """记录审查与再分配的全部调整原因。"""

    adjustments: list[str] = field(default_factory=list)


def review_worklist(works: list[WorkItem]) -> tuple[list[WorkItem], WorklistReviewReport]:
    """审查并规范化 WorkList，返回调整后的列表与调整报告。"""

    report = WorklistReviewReport()
    normalized = list(works)

    # 1) 容量拆分：超大 Work 按文件数量切分，并报告拆分结果。
    original_ids = {item.id for item in normalized}
    normalized = split_oversized_works(normalized)
    result_ids = {item.id for item in normalized}
    for original_id in original_ids - result_ids:
        sub_ids = [item.id for item in normalized if item.id.startswith(original_id)]
        report.adjustments.append(
            f"Work {original_id} 目标文件超过 {MAX_WORK_TARGET_FILES} 个，"
            f"已拆分为 {len(sub_ids)} 个子 Work（{', '.join(sub_ids)}）"
        )

    # 2) 依赖审查：移除自引用、无效依赖和依赖环。
    report.adjustments.extend(_fix_dependencies(normalized))

    # 3) 目标文件审查：去重 + 敏感路径过滤。
    for item in normalized:
        targets = list(dict.fromkeys(item.target_files))
        if len(targets) != len(item.target_files):
            report.adjustments.append(f"Work {item.id} 目标文件重复，已去重")
        filtered = [
            path
            for path in targets
            if not is_sensitive_workspace_path(path)
            and not is_build_output_path(path)
        ]
        if len(filtered) != len(targets):
            report.adjustments.append(
                f"Work {item.id} 含敏感路径或构建产物（dist/release 等），已过滤"
            )
        item.target_files = filtered

    # 4) 执行类型再分配：纯生成走确定性 factory，纯验证走确定性验证执行器。
    for item in normalized:
        reclassified = _reclassify_execution_type(item)
        if reclassified:
            report.adjustments.append(
                f"Work {item.id} 执行类型 {item.execution_type} → {reclassified}"
            )
            item.execution_type = reclassified  # type: ignore[assignment]

    # 5) 文件重叠报告（运行时仍会按优先级串行，这里只做透明提示）。
    file_owners: dict[str, list[str]] = {}
    for item in normalized:
        for path in item.target_files:
            file_owners.setdefault(path, []).append(item.id)
    for path, owners in file_owners.items():
        if len(owners) > 1:
            report.adjustments.append(
                f"文件 {path} 被多个 Work 声明（{', '.join(owners)}），执行时将按优先级串行"
            )

    return normalized, report


def _fix_dependencies(works: list[WorkItem]) -> list[str]:
    """移除自引用、无效依赖与依赖环，返回调整说明。"""

    by_id = {item.id: item for item in works}
    notes: list[str] = []
    for item in works:
        kept: list[str] = []
        for dependency in item.dependencies:
            if dependency == item.id:
                notes.append(f"Work {item.id} 存在自引用依赖，已移除")
                continue
            if dependency not in by_id:
                notes.append(f"Work {item.id} 依赖不存在的 {dependency}，已移除")
                continue
            if _can_reach(by_id, dependency, item.id):
                notes.append(f"Work {item.id} → {dependency} 构成依赖环，已移除该边")
                continue
            kept.append(dependency)
        item.dependencies = list(dict.fromkeys(kept))
    return notes


def _can_reach(
    by_id: dict[str, WorkItem],
    start: str,
    target: str,
) -> bool:
    """判断从 start 沿依赖边能否到达 target。"""

    visited: set[str] = set()
    stack = [start]
    while stack:
        current = stack.pop()
        if current == target:
            return True
        if current in visited or current not in by_id:
            continue
        visited.add(current)
        stack.extend(by_id[current].dependencies)
    return False


def _reclassify_execution_type(work: WorkItem) -> str:
    """按确定性规则返回更合适的执行类型；无需调整时返回空串。"""

    if work.execution_type not in {"coding", "agent"}:
        return ""
    if work.file_operations:
        return "filesystem"
    text = f"{work.title} {work.objective}".lower()
    has_factory = any(term in text for term in FACTORY_GENERATE_TERMS)
    has_generate = any(term in text for term in GENERATE_TERMS)
    has_page = any(term in text for term in PAGE_INTENT_TERMS)
    if (
        has_factory
        and has_generate
        and not has_page
        and not is_factory_audit_work(work)
    ):
        return "artifact"
    has_validation = any(term in text for term in VALIDATION_ONLY_TERMS)
    has_edit = any(term in text for term in EDIT_INTENT_TERMS)
    if has_validation and not has_edit:
        return "validation"
    return ""


__all__ = ["WorklistReviewReport", "review_worklist"]
