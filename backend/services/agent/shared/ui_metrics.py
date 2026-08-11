"""UI Metrics 统计修正。

当前 UI 容易显示 token 停止增长、Work 未完成、状态不同步。
本模块提供标准化的状态统计和指标报告。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(slots=True)
class ExecutionMetrics:
    """执行状态指标。"""

    total_tokens: int = 0
    active_tokens: int = 0
    compressed_tokens: int = 0
    cleaned_tokens: int = 0
    completed_works: int = 0
    failed_works: int = 0
    retry_count: int = 0
    pending_works: int = 0
    running_works: int = 0
    skipped_works: int = 0

    def to_json(self) -> dict[str, Any]:
        """序列化为前端可用的 JSON。"""

        return {
            "totalTokens": self.total_tokens,
            "activeTokens": self.active_tokens,
            "compressedTokens": self.compressed_tokens,
            "cleanedTokens": self.cleaned_tokens,
            "completedWorks": self.completed_works,
            "failedWorks": self.failed_works,
            "retryCount": self.retry_count,
            "pendingWorks": self.pending_works,
            "runningWorks": self.running_works,
            "skippedWorks": self.skipped_works,
        }

    def to_ui_summary(self) -> dict[str, Any]:
        """生成 UI 展示用的摘要。"""

        return {
            "tokenUsage": {
                "total": self._format_number(self.total_tokens),
                "active": self._format_number(self.active_tokens),
                "compressed": self._format_number(self.compressed_tokens),
            },
            "workStatus": {
                "completed": self.completed_works,
                "failed": self.failed_works,
                "retry": self.retry_count,
                "pending": self.pending_works,
                "running": self.running_works,
                "skipped": self.skipped_works,
            },
        }

    @staticmethod
    def _format_number(n: int) -> str:
        """格式化数字为人类可读形式。"""

        if n >= 1_000_000:
            return f"{n / 1_000_000:.1f}M"
        if n >= 1_000:
            return f"{n / 1_000:.0f}k"
        return str(n)


class MetricsCollector:
    """收集并汇总执行指标。"""

    def __init__(self) -> None:
        """初始化收集器。"""

        self._metrics = ExecutionMetrics()
        self._work_history: list[dict[str, Any]] = []

    def record_tokens(
        self,
        *,
        total: int | None = None,
        active: int | None = None,
        compressed: int | None = None,
        cleaned: int | None = None,
    ) -> None:
        """记录 Token 指标。"""

        if total is not None:
            self._metrics.total_tokens = total
        if active is not None:
            self._metrics.active_tokens = active
        if compressed is not None:
            self._metrics.compressed_tokens = compressed
        if cleaned is not None:
            self._metrics.cleaned_tokens = cleaned

    def record_work_status(
        self,
        *,
        completed: int | None = None,
        failed: int | None = None,
        retry: int | None = None,
        pending: int | None = None,
        running: int | None = None,
        skipped: int | None = None,
    ) -> None:
        """记录 Work 状态。"""

        if completed is not None:
            self._metrics.completed_works = completed
        if failed is not None:
            self._metrics.failed_works = failed
        if retry is not None:
            self._metrics.retry_count = retry
        if pending is not None:
            self._metrics.pending_works = pending
        if running is not None:
            self._metrics.running_works = running
        if skipped is not None:
            self._metrics.skipped_works = skipped

    def record_work_event(
        self,
        work_id: str,
        event: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        """记录 Work 事件历史。"""

        self._work_history.append(
            {
                "workId": work_id,
                "event": event,
                "details": details or {},
            }
        )

    def increment_retry(self) -> None:
        """增加重试计数。"""

        self._metrics.retry_count += 1

    def from_ledger_snapshot(self, snapshot: dict[str, Any]) -> None:
        """从 WorkLedger 快照提取指标。"""

        self._metrics.completed_works = snapshot.get("succeeded", 0)
        self._metrics.failed_works = snapshot.get("failed", 0)
        self._metrics.pending_works = snapshot.get("pending", 0)
        self._metrics.running_works = snapshot.get("running", 0)
        self._metrics.skipped_works = snapshot.get("skipped", 0)

    def from_token_budget(self, budget_metrics: dict[str, Any]) -> None:
        """从 TokenBudgetGuard 提取指标。"""

        self._metrics.total_tokens = budget_metrics.get("totalTokens", 0)
        self._metrics.active_tokens = budget_metrics.get("activeTokens", 0)
        self._metrics.compressed_tokens = budget_metrics.get("compressedTokens", 0)
        self._metrics.cleaned_tokens = budget_metrics.get("cleanedTokens", 0)

    def get_metrics(self) -> ExecutionMetrics:
        """获取当前指标。"""

        return self._metrics

    def to_json(self) -> dict[str, Any]:
        """导出完整 JSON。"""

        return {
            "metrics": self._metrics.to_json(),
            "uiSummary": self._metrics.to_ui_summary(),
            "historyCount": len(self._work_history),
        }

    def reset(self) -> None:
        """重置所有指标。"""

        self._metrics = ExecutionMetrics()
        self._work_history.clear()


__all__ = [
    "ExecutionMetrics",
    "MetricsCollector",
]
