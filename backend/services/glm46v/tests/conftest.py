"""glm46v 测试共享夹具：默认关闭全局节流，避免拖慢既有测试。

全局节拍器与信号量是模块级状态（rate_limit 模块），会影响所有走
GLM46VClient 的测试。这里统一把最小间隔设为 0、并发上限放大；
节流行为本身在 test_rate_limit.py 中单独显式验证。
"""

from __future__ import annotations

import pytest

from backend.services.glm46v import rate_limit


@pytest.fixture(autouse=True)
def _disable_global_throttle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(rate_limit, "MIN_INTERVAL_SECONDS", 0.0)
    monkeypatch.setattr(rate_limit, "MAX_CONCURRENCY", 64)
    monkeypatch.setattr(
        rate_limit,
        "_concurrency_semaphore",
        __import__("asyncio").Semaphore(64),
    )
