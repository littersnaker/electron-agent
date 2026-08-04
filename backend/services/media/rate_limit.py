"""全局媒体请求限流。

百炼免费档限流通常按“每分钟 QPS/RPM”而不是并发数，单次运行内的并发信号量
管不住“多次运行/直连生成/重试”叠加在同一分钟窗口。这里用进程级最小请求间隔
兜底：所有媒体请求（漫剧管线 + 直连生成）共享一个节拍器，默认每 2.5 秒
最多发出一个请求，彻底避免突发。
"""

from __future__ import annotations

import asyncio
import os
import time

MIN_MEDIA_INTERVAL_SECONDS = float(
    os.getenv("MEDIA_MIN_INTERVAL", "2.5")
)

_lock = asyncio.Lock()
_last_request_at = 0.0


async def throttle_media_request() -> None:
    """等待到允许发出下一个媒体请求的时刻（进程级）。"""

    global _last_request_at
    async with _lock:
        now = time.monotonic()
        wait = MIN_MEDIA_INTERVAL_SECONDS - (now - _last_request_at)
        if wait > 0:
            await asyncio.sleep(wait)
        _last_request_at = time.monotonic()


__all__ = ["MIN_MEDIA_INTERVAL_SECONDS", "throttle_media_request"]
