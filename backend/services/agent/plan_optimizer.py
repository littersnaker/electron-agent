"""在 Planner 之后细化过大的功能 Work，并保持原有依赖关系。"""

from __future__ import annotations

from dataclasses import dataclass, replace

from backend.services.agent.work_models import WorkItem

_COMMERCE_TERMS = (
    "电商",
    "商城",
    "商品",
    "购物车",
    "结算",
    "订单",
    "小程序",
    "commerce",
    "ecommerce",
)
_BROAD_TERMS = (
    "完整",
    "全部",
    "整体",
    "完善",
    "完成代码修改",
    "商城模块",
    "电商模块",
)


@dataclass(frozen=True, slots=True)
class _DomainRule:
    """描述一个可独立验收的电商功能域。"""

    key: str
    title: str
    terms: tuple[str, ...]
    path_terms: tuple[str, ...]
    acceptance: tuple[str, ...]


_DOMAIN_RULES = (
    _DomainRule(
        key="catalog",
        title="商品分类、列表与详情",
        terms=("商品", "分类", "详情", "sku", "product", "catalog"),
        path_terms=("product", "catalog", "category", "sku", "detail", "goods"),
        acceptance=(
            "首页或分类页能够展示统一数据源中的商品",
            "商品详情支持 SKU 与数量选择",
        ),
    ),
    _DomainRule(
        key="cart",
        title="购物车状态与交互",
        terms=("购物车", "加购", "数量", "删除", "cart"),
        path_terms=("cart", "basket"),
        acceptance=(
            "支持加入购物车、修改数量和删除商品",
            "购物车状态与统一商品和 SKU 契约一致",
        ),
    ),
    _DomainRule(
        key="checkout",
        title="结算与订单提交",
        terms=("结算", "地址", "优惠券", "提交订单", "checkout", "payment"),
        path_terms=("checkout", "settle", "address", "coupon", "payment", "order"),
        acceptance=(
            "结算页可读取购物车并创建模拟订单",
            "提交过程覆盖加载、失败和成功反馈",
        ),
    ),
    _DomainRule(
        key="account",
        title="订单记录与用户中心",
        terms=("订单列表", "订单详情", "我的订单", "用户", "个人中心", "order list", "profile", "account"),
        path_terms=("order", "profile", "account", "user", "mine"),
        acceptance=(
            "用户中心能够展示模拟用户与订单记录",
            "订单列表和详情使用统一订单契约",
        ),
    ),
    _DomainRule(
        key="shell",
        title="应用入口、路由与全局导航",
        terms=("路由", "导航", "tabbar", "入口", "app config", "全局配置"),
        path_terms=("app.config", "app.json", "route", "router", "tabbar", "navigation"),
        acceptance=(
            "新增页面已注册到项目现有路由或小程序配置",
            "入口和导航不破坏已有页面",
        ),
    ),
)


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
