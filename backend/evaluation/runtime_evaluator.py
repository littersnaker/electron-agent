"""Runtime 级基础评估指标。"""

from __future__ import annotations

import time
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class RuntimeEvaluation:
    """保存一次 Runtime 执行的延迟、事件数和终态。"""

    duration_ms: int
    event_count: int
    status: str

    def to_json(self) -> dict[str, object]:
        """转换成任务元数据可保存的稳定 JSON。"""

        return {
            "durationMs": self.duration_ms,
            "eventCount": self.event_count,
            "status": self.status,
        }


class RuntimeEvaluator:
    """使用单调时钟评估 Runtime 延迟，避免系统时间调整造成负值。"""

    def begin(self) -> float:
        """返回一次评估的单调时钟起点。"""

        return time.monotonic()

    def finish(
        self,
        *,
        started_at: float,
        event_count: int,
        status: str,
    ) -> RuntimeEvaluation:
        """根据起点和终态生成评估结果。"""

        duration_ms = max(0, round((time.monotonic() - started_at) * 1_000))
        return RuntimeEvaluation(
            duration_ms=duration_ms,
            event_count=max(0, event_count),
            status=status,
        )
