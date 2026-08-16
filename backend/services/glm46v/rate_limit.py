"""GLM-4.6V-Flash 全局限流。

GLM-4.6V-Flash 是免费模型，按“每分钟 QPS/RPM”限流而不是并发数。QA/Code 图片
预处理（enrichment）、review 截图验证（verify）与图片识别 Agent 共用同一个
GLM46VClient，任何一路突发都会挤占同一分钟窗口。这里用进程级最小请求间隔 +
并发信号量兜底：所有消费方共享一个节拍器，默认每 2.5 秒最多发出一个请求，
同时限制同时在途的并发请求数，彻底避免突发叠加。
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

MIN_INTERVAL_SECONDS = float(os.getenv("GLM46V_MIN_INTERVAL_SECONDS", "2.5"))
MAX_CONCURRENCY = max(1, int(os.getenv("GLM46V_MAX_CONCURRENCY", "2")))

_interval_lock = asyncio.Lock()
_last_request_at = 0.0
_concurrency_semaphore = asyncio.Semaphore(MAX_CONCURRENCY)


@asynccontextmanager
async def glm46v_request_slot() -> AsyncIterator[None]:
    """为一次 GLM-4.6V 请求抢占全局并发槽并等待最小间隔。

    信号量覆盖整个 ``async with`` 生命周期，即调用方必须在槽内完成真正的
    HTTP 请求，才能让并发上限真实生效。所有 GLM46VClient 实例共享同一套
    节拍器与信号量，确保多个消费方（QA/Code 图片预处理、review 截图验证、
    图片识别 Agent）叠加时也不会突破免费档的每分钟速率窗口。
    """

    global _last_request_at
    async with _concurrency_semaphore:
        async with _interval_lock:
            if MIN_INTERVAL_SECONDS > 0:
                now = time.monotonic()
                wait = MIN_INTERVAL_SECONDS - (now - _last_request_at)
                if wait > 0:
                    await asyncio.sleep(wait)
                _last_request_at = time.monotonic()
        yield


__all__ = [
    "MAX_CONCURRENCY",
    "MIN_INTERVAL_SECONDS",
    "glm46v_request_slot",
]
