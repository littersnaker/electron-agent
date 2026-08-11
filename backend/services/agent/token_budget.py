"""Token Budget 预算控制。

统一控制 Planner token、Worker token、Retry token 和 Tool output token。
超过预算时执行压缩、清理、降级、阻止策略。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

# 默认 Token 预算配置
TOKEN_LIMITS = {
    "planner": 12_000,
    "worker": 128_000,
    "retry": 12_000,
    "context": 24_000,
}


@dataclass(slots=True)
class TokenBudget:
    """单个工作域的 token 预算与消耗跟踪。"""

    limit: int
    consumed: int = 0
    compressed: int = 0
    cleaned: int = 0

    @property
    def remaining(self) -> int:
        """剩余可用预算。"""

        return max(0, self.limit - self.consumed)

    @property
    def exceeded(self) -> bool:
        """是否已超出预算。"""

        return self.consumed > self.limit

    @property
    def usage_ratio(self) -> float:
        """预算使用率（0.0 ~ 1.0+）。"""

        return self.consumed / max(self.limit, 1)

    def consume(self, tokens: int) -> None:
        """记录 token 消耗。"""

        self.consumed += max(0, tokens)

    def record_compressed(self, saved_tokens: int) -> None:
        """记录通过压缩节省的 token 数。"""

        self.compressed += max(0, saved_tokens)

    def record_cleaned(self, saved_tokens: int) -> None:
        """记录通过清理节省的 token 数。"""

        self.cleaned += max(0, saved_tokens)

    def to_json(self) -> dict[str, Any]:
        """序列化为 JSON。"""

        return {
            "limit": self.limit,
            "consumed": self.consumed,
            "remaining": self.remaining,
            "exceeded": self.exceeded,
            "usageRatio": round(self.usage_ratio, 4),
            "compressed": self.compressed,
            "cleaned": self.cleaned,
        }


class TokenBudgetGuard:
    """全局 Token 预算守卫，统一管理各工作域预算。"""

    def __init__(self, limits: dict[str, int] | None = None) -> None:
        """初始化预算守卫，可传入自定义配置。"""

        self._limits = {**TOKEN_LIMITS, **(limits or {})}
        env_budget_map = (
            ("planner", "CODE_AGENT_PLANNER_TOKEN_BUDGET", 1_000, 1_000_000),
            ("worker", "CODE_AGENT_WORKER_TOKEN_BUDGET", 8_000, 1_000_000),
            ("retry", "CODE_AGENT_RETRY_TOKEN_BUDGET", 1_000, 1_000_000),
            ("context", "CODE_AGENT_CONTEXT_TOKEN_BUDGET", 4_000, 1_000_000),
        )
        for domain, env_name, minimum, maximum in env_budget_map:
            if limits is None or domain not in limits:
                self._limits[domain] = _env_int(
                    env_name,
                    self._limits[domain],
                    minimum,
                    maximum,
                )
        self._budgets: dict[str, TokenBudget] = {
            key: TokenBudget(limit=limit) for key, limit in self._limits.items()
        }

    def get(self, domain: str) -> TokenBudget:
        """获取指定域的预算。不存在时自动创建无限预算条目。"""

        if domain not in self._budgets:
            self._budgets[domain] = TokenBudget(limit=999_999_999)
        return self._budgets[domain]

    def consume(self, domain: str, tokens: int) -> bool:
        """记录消耗并返回是否仍在预算内。"""

        budget = self.get(domain)
        budget.consume(tokens)
        return not budget.exceeded

    def check(self, domain: str, required_tokens: int) -> bool:
        """检查指定域是否有足够剩余预算。"""

        return self.get(domain).remaining >= required_tokens

    def total_consumed(self) -> int:
        """返回所有域的总消耗。"""

        return sum(b.consumed for b in self._budgets.values())

    def total_limit(self) -> int:
        """返回所有域的总预算。"""

        return sum(b.limit for b in self._budgets.values())

    def any_exceeded(self) -> bool:
        """是否有任何域超出预算。"""

        return any(b.exceeded for b in self._budgets.values())

    def exceedance_report(self) -> dict[str, dict[str, Any]]:
        """返回超出预算域的报告。"""

        return {
            domain: budget.to_json()
            for domain, budget in self._budgets.items()
            if budget.exceeded
        }

    def apply_mitigation(self, domain: str) -> dict[str, Any]:
        """对超出预算的域执行缓解策略。

        1. 压缩 context
        2. 清理历史
        3. 降级输出详细度
        4. 阻止继续无限调用
        """

        budget = self.get(domain)
        if not budget.exceeded:
            return {"mitigated": False, "domain": domain, "reason": "预算未超限"}

        actions: list[str] = []

        # 根据超预算程度执行不同策略
        ratio = budget.usage_ratio
        if ratio > 1.5:
            actions.append("block")
        elif ratio > 1.25:
            actions.append("downgrade")
            actions.append("clean")
        else:
            actions.append("compress")
            actions.append("clean")

        return {
            "mitigated": True,
            "domain": domain,
            "actions": actions,
            "budget": budget.to_json(),
        }

    def snapshot(self) -> dict[str, dict[str, Any]]:
        """导出全部预算快照。"""

        return {domain: budget.to_json() for domain, budget in self._budgets.items()}

    def restore(self, snapshot: dict[str, Any]) -> None:
        """从 Worker Checkpoint 恢复各预算域的累计数据。"""

        for domain, value in snapshot.items():
            if not isinstance(value, dict):
                continue
            budget = self.get(str(domain))
            budget.limit = max(1, int(value.get("limit") or budget.limit))
            budget.consumed = max(0, int(value.get("consumed") or 0))
            budget.compressed = max(0, int(value.get("compressed") or 0))
            budget.cleaned = max(0, int(value.get("cleaned") or 0))

    def to_ui_metrics(self) -> dict[str, Any]:
        """生成 UI 可展示的指标。"""

        total = self.total_consumed()
        limit = self.total_limit()
        active = sum(
            max(0, b.consumed - b.compressed - b.cleaned)
            for b in self._budgets.values()
        )
        return {
            "totalTokens": total,
            "activeTokens": active,
            "compressedTokens": sum(b.compressed for b in self._budgets.values()),
            "cleanedTokens": sum(b.cleaned for b in self._budgets.values()),
            "totalLimit": limit,
            "domains": self.snapshot(),
        }


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    """读取整数环境变量并限制在安全区间。"""

    try:
        value = int(os.getenv(name, str(default)).strip())
    except ValueError:
        value = default
    return max(minimum, min(value, maximum))


__all__ = [
    "TokenBudget",
    "TokenBudgetGuard",
    "TOKEN_LIMITS",
]
