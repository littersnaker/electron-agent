"""领域规则配置加载器。

业务词、领域拆分规则和执行类型词表统一外置到 ``config/agent-domain-rules.json``，
核心循环只读取数据，不再在代码里写业务关键词。新增领域或调整词表不需要改代码。
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

CONFIG_PATH = (
    Path(__file__).resolve().parents[3] / "config" / "agent-domain-rules.json"
)


@lru_cache(maxsize=1)
def domain_rules() -> dict:
    """读取领域规则配置；文件缺失或损坏时安全降级为空配置。"""

    try:
        payload = json.loads(CONFIG_PATH.read_text("utf-8"))
    except (OSError, ValueError):
        return {}
    return payload if isinstance(payload, dict) else {}


def default_factory_domain_id() -> str:
    """返回默认工厂领域 ID，供未显式指定 domainId 的 Work 使用。"""

    return str(domain_rules().get("defaultFactoryDomainId") or "commerce-miniapp")


def harness_rules() -> dict:
    """返回 Harness 工程识别规则。"""

    return domain_rules().get("harness") or {}


def plan_optimizer_rules() -> dict:
    """返回 WorkList 领域拆分规则。"""

    return domain_rules().get("planOptimizer") or {}


def work_router_rules() -> dict:
    """返回 Work 路由执行类型词表。"""

    return domain_rules().get("workRouter") or {}


def worklist_reviewer_rules() -> dict:
    """返回 WorkList 审查执行类型词表。"""

    return domain_rules().get("worklistReviewer") or {}


def factory_audit_rules() -> dict:
    """返回工厂审计错误分类词表。"""

    return domain_rules().get("factoryAudit") or {}


def complete_work_rules() -> dict:
    """返回 complete_work 验收约束规则。"""

    return domain_rules().get("completeWork") or {}


__all__ = [
    "CONFIG_PATH",
    "complete_work_rules",
    "default_factory_domain_id",
    "domain_rules",
    "factory_audit_rules",
    "harness_rules",
    "plan_optimizer_rules",
    "work_router_rules",
    "worklist_reviewer_rules",
]
