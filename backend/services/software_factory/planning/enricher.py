"""确保电商 Mock 与页面接入任务形成完整工程闭环。"""

from __future__ import annotations

from backend.services.agent.shared.work_models import WorkItem

FACTORY_INTENT_TERMS = (
    "电商",
    "商城",
    "购物车",
    "商品详情",
    "订单",
    "小程序",
    "ecommerce",
    "commerce",
    "shopping cart",
)
DATA_CHAIN_TERMS = (
    "mock",
    "模拟数据",
    "假数据",
    "接口",
    "api",
    "接上",
    "接入",
    "绑定",
    "数据源",
)


def enrich_software_factory_works(
    user_request: str,
    works: list[WorkItem],
    *,
    greenfield: bool = False,
) -> list[WorkItem]:
    """在电商数据接入任务中补齐数据契约闭环，但收敛为两个 Work 而不是整条工程链。

    原实现会把“计划-生成-绑定-验收”拆成 4 个串行 Work，导致 WorkList 过大且并行度
    下降。现在合并为：1) 契约计划+生成；2) 页面接入+一致性校验。两者都由 Coding
    Worker 驱动（factory 工具内部完成 plan/generate/validate）。
    """

    if not _needs_software_factory(user_request):
        return works

    enriched = list(works)
    searchable = "\n".join(
        f"{item.title} {item.objective} {' '.join(item.acceptance_criteria)}"
        for item in works
    ).lower()
    used_ids = {item.id for item in enriched}

    contract_id = _next_id("SF001", used_ids)
    binding_id = _next_id("SF002", used_ids | {contract_id})
    contract_terms = (
        "领域模型",
        "domain",
        "factory plan",
        "openapi",
        "mock repository",
        "mock 数据",
        "mock data",
        "数据源",
        "data source",
        "契约",
        "api client",
        "factory generate",
    )
    if not _contains_any(searchable, contract_terms):
        enriched.insert(
            0,
            WorkItem(
                id=contract_id,
                title="建立电商数据契约并生成 Mock 与 OpenAPI 数据源",
                objective=(
                    "读取真实项目技术栈并调用 factory plan 确认商品、SKU、购物车、用户、"
                    "地址、优惠券和订单的单一事实源与安全生成目录；随后调用 factory generate "
                    "生成 domain-schema、OpenAPI、TypeScript 类型、稳定 Mock、Mock Repository、"
                    "真实 API Client 和统一 data source。若输出目录已存在且 factory validate "
                    "通过，直接复用产物，不重复生成；不覆盖或猜测现有页面实现。"
                ),
                acceptance_criteria=[
                    "已识别前端框架和源码根目录",
                    "已取得 Software Factory 生成文件清单",
                    "Mock 字段与 TypeScript 类型一致",
                    "API Client 与 OpenAPI operationId 一致",
                    "页面可在 mock 和 api 模式间切换",
                ],
                priority=10,
                serial_group="software-factory-contract",
                execution_type="artifact",
            ),
        )
    else:
        contract_id = _matching_work_id(enriched, contract_terms)

    binding_terms = (
        "页面绑定",
        "页面接入",
        "loading",
        "空状态",
        "一致性校验",
        "factory validate",
        "契约校验",
        "数据闭环",
    )
    if not _contains_any(searchable, binding_terms) and not greenfield:
        enriched.append(
            WorkItem(
                id=binding_id,
                title="接入电商页面并校验数据闭环",
                objective=(
                    "读取商品列表、详情、购物车和订单页面，删除硬编码业务数组，通过现有 "
                    "Store、Context 或依赖注入接入统一 data source；随后调用 factory validate "
                    "校验契约、Mock 与页面数据闭环，并执行项目 lint、typecheck、test、build；"
                    "根据真实错误修复，不得只输出验证建议。"
                ),
                acceptance_criteria=[
                    "商品列表和详情来自同一 Product/Sku 契约",
                    "购物车和订单状态使用 Repository 或 API 返回值",
                    "页面具有 loading、error、empty、success 四种状态",
                    "Software Factory 一致性校验通过",
                    "项目质量命令通过或明确记录无法执行原因",
                ],
                dependencies=[contract_id] if contract_id else [],
                priority=30,
                serial_group="commerce-page-binding",
                execution_type="coding",
            )
        )

    return _deduplicate_dependencies(enriched)


def _needs_software_factory(user_request: str) -> bool:
    """判断请求是否同时具有电商领域和数据接入意图。"""

    normalized = user_request.lower()
    return _contains_any(normalized, FACTORY_INTENT_TERMS) and _contains_any(
        normalized,
        DATA_CHAIN_TERMS,
    )


def _contains_any(text: str, terms: tuple[str, ...]) -> bool:
    """判断文本是否包含任意关键词。"""

    return any(term in text for term in terms)


def _matching_work_id(works: list[WorkItem], terms: tuple[str, ...]) -> str:
    """返回首个覆盖指定能力的工作项 ID。"""

    for item in works:
        text = f"{item.title} {item.objective}".lower()
        if _contains_any(text, terms):
            return item.id
    return ""


def _next_id(preferred: str, used_ids: set[str]) -> str:
    """在 Planner 已使用同名 ID 时生成稳定的不冲突 ID。"""

    if preferred not in used_ids:
        return preferred
    prefix = preferred.rstrip("0123456789") or "SF"
    for index in range(1, 1000):
        candidate = f"{prefix}{index:03d}"
        if candidate not in used_ids:
            return candidate
    raise ValueError("无法为 Software Factory 工作项分配唯一 ID")


def _deduplicate_dependencies(works: list[WorkItem]) -> list[WorkItem]:
    """移除不存在、自引用和重复依赖，避免调度器形成无效图。"""

    valid_ids = {item.id for item in works}
    for item in works:
        item.dependencies = list(
            dict.fromkeys(
                dependency
                for dependency in item.dependencies
                if dependency in valid_ids and dependency != item.id
            )
        )
    return works
