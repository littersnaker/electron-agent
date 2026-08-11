"""在 Planner 之后细化过大的功能 Work，并保持原有依赖关系。"""

from __future__ import annotations

from dataclasses import dataclass, replace

from backend.services.agent.shared.domain_rules import plan_optimizer_rules
from backend.services.agent.shared.work_models import WorkItem


def _load_commerce_terms() -> tuple[str, ...]:
    """从配置读取电商领域触发词，避免业务词写死在代码里。"""

    return tuple(
        str(item)
        for item in plan_optimizer_rules().get("commerceTerms") or ()
    )


def _load_broad_terms() -> tuple[str, ...]:
    """从配置读取宽泛任务触发词。"""

    return tuple(
        str(item)
        for item in plan_optimizer_rules().get("broadTerms") or ()
    )


_COMMERCE_TERMS = _load_commerce_terms()
_BROAD_TERMS = _load_broad_terms()


@dataclass(frozen=True, slots=True)
class _DomainRule:
    """描述一个可独立验收的电商功能域。"""

    key: str
    title: str
    terms: tuple[str, ...]
    path_terms: tuple[str, ...]
    acceptance: tuple[str, ...]


def _load_domain_rules() -> tuple[_DomainRule, ...]:
    """从配置读取电商功能域拆分规则，避免业务规则写死在代码里。"""

    rules: list[_DomainRule] = []
    for entry in plan_optimizer_rules().get("domainRules") or []:
        if not isinstance(entry, dict):
            continue
        rules.append(
            _DomainRule(
                key=str(entry.get("key") or ""),
                title=str(entry.get("title") or ""),
                terms=tuple(str(item) for item in entry.get("terms") or ()),
                path_terms=tuple(
                    str(item) for item in entry.get("pathTerms") or ()
                ),
                acceptance=tuple(
                    str(item) for item in entry.get("acceptance") or ()
                ),
            )
        )
    return tuple(rules)


_DOMAIN_RULES = _load_domain_rules()


def optimize_work_granularity(
    user_request: str,
    works: list[WorkItem],
) -> list[WorkItem]:
    """把同时覆盖多个电商功能域的 coding Work 拆成可并行的小 Work。"""

    normalized_request = user_request.lower()
    if not any(term in normalized_request for term in _COMMERCE_TERMS):
        return works

    replacements: dict[str, list[WorkItem]] = {}
    optimized: list[WorkItem] = []
    used_ids = {item.id for item in works}
    for work in works:
        split = _split_work(work, normalized_request, used_ids)
        if len(split) <= 1:
            optimized.append(work)
            continue
        replacements[work.id] = split
        optimized.extend(split)
        used_ids.update(item.id for item in split)

    if not replacements:
        return works

    # 任何原来依赖大 Work 的后续验收项，都必须等待其全部替代 Work 完成。
    for item in optimized:
        dependencies: list[str] = []
        for dependency in item.dependencies:
            replacement = replacements.get(dependency)
            if replacement:
                dependencies.extend(candidate.id for candidate in replacement)
            else:
                dependencies.append(dependency)
        item.dependencies = list(
            dict.fromkeys(value for value in dependencies if value != item.id)
        )
    return optimized


def _split_work(
    work: WorkItem,
    normalized_request: str,
    used_ids: set[str],
) -> list[WorkItem]:
    """判断一个 Work 是否过大，并返回保持语义的细化结果。

    为避免 WorkList 过度膨胀，只有同时命中多个功能域且目标文件足够多时才拆分；
    拆分上限 6 个子 Work，普通 1-3 个功能域的多文件任务保持单个 Work 由 Worker 分批编辑。
    """

    if work.execution_type not in {"agent", "coding"}:
        return [work]
    text = " ".join(
        [work.title, work.objective, *work.acceptance_criteria]
    ).lower()
    matched = [rule for rule in _DOMAIN_RULES if any(term in text for term in rule.terms)]
    if len(matched) < 3 or len(work.target_files) < 10:
        return [work]
    matched = matched[:6]

    target_map = _partition_target_files(work.target_files, matched)
    generated: list[WorkItem] = []
    for index, rule in enumerate(matched, start=1):
        work_id = _subwork_id(work.id, index, used_ids | {item.id for item in generated})
        generated.append(
            replace(
                work,
                id=work_id,
                title=rule.title,
                objective=(
                    f"在现有 {work.title} 范围内只完成“{rule.title}”。"
                    f"复用项目现有架构和统一数据源；不要顺带实现其他功能域。"
                ),
                acceptance_criteria=list(rule.acceptance),
                dependencies=list(work.dependencies),
                target_files=target_map[rule.key],
                serial_group="",
                status="pending",
                attempts=0,
                summary="",
                error="",
                changed_files=[],
                commands=[],
            )
        )

    # 结算依赖购物车的可用状态；其余功能域保持并行，避免再次形成瀑布链。
    by_key = {rule.key: item for rule, item in zip(matched, generated, strict=True)}
    if "checkout" in by_key and "cart" in by_key:
        by_key["checkout"].dependencies.append(by_key["cart"].id)
    return generated


def _partition_target_files(
    paths: list[str],
    matched: list[_DomainRule],
) -> dict[str, list[str]]:
    """把原 Work 的目标文件唯一分配给最相关子域，确保路径不会丢失或重复。"""

    result = {rule.key: [] for rule in matched}
    if not matched:
        return result
    for path in paths:
        normalized = path.lower()
        scored = [
            (sum(term in normalized for term in rule.path_terms), index, rule)
            for index, rule in enumerate(matched)
        ]
        score, _index, selected = max(scored, key=lambda item: (item[0], -item[1]))
        if score <= 0:
            selected = matched[0]
        result[selected.key].append(path)
    return result


def _subwork_id(base_id: str, index: int, used_ids: set[str]) -> str:
    """生成稳定、短小且不与现有 Work 冲突的细化 ID。"""

    stem = base_id[:34]
    for suffix in (chr(64 + index), f"S{index}", f"{index}"):
        candidate = f"{stem}{suffix}"[:40]
        if candidate not in used_ids:
            return candidate
    raise ValueError(f"无法为 {base_id} 生成细化 Work ID")


__all__ = ["optimize_work_granularity"]
