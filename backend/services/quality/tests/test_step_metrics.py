"""LLM 单步性能指标测试：usage cached、聚合、落库。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.llm.types import LlmUsage
from backend.services.quality.step_metrics import (
    aggregate_step_metrics,
    record_step_metric,
)


def test_llm_usage_cached_default_zero() -> None:
    """LlmUsage 新增 cached_tokens 默认 0。"""

    usage = LlmUsage(prompt=10, completion=5, total=15)
    assert usage.cached_tokens == 0
    usage_with_cache = LlmUsage(prompt=10, completion=5, total=15, cached_tokens=7)
    assert usage_with_cache.cached_tokens == 7


@pytest.mark.asyncio
async def test_record_and_aggregate_step_metrics(tmp_path: Path, monkeypatch) -> None:
    """落库后按会话聚合应返回正确的性能指标。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    from backend.core.config import get_settings

    get_settings.cache_clear()
    from backend.services.workspace.database import initialize_database

    await initialize_database()

    await record_step_metric(
        request_id="req-1",
        session_id="s1",
        work_id="w1",
        provider="deepseek",
        model="deepseek-v4-flash",
        ttft_ms=1200,
        tok_per_sec=45.5,
        prompt_tokens=1000,
        completion_tokens=500,
        cached_tokens=200,
        total_ms=5000,
    )
    await record_step_metric(
        request_id="req-2",
        session_id="s1",
        work_id="w1",
        provider="deepseek",
        model="deepseek-v4-flash",
        ttft_ms=800,
        tok_per_sec=30.0,
        prompt_tokens=2000,
        completion_tokens=1000,
        cached_tokens=0,
        total_ms=8000,
    )

    aggregated = await aggregate_step_metrics("s1")
    assert aggregated["steps"] == 2
    assert aggregated["avgTtftMs"] == 1000  # (1200+800)/2
    assert aggregated["totalPromptTokens"] == 3000
    assert aggregated["totalCompletionTokens"] == 1500
    assert aggregated["totalCachedTokens"] == 200

    # 其他会话应返回空聚合。
    empty = await aggregate_step_metrics("s-other")
    assert empty["steps"] == 0
