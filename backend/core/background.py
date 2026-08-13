"""Fire-and-forget 后台任务的统一句柄登记。

模块级集合持有每个后台任务强引用，避免任务仅被事件循环弱引用而在运行中被
GC 取消；应用关闭时 ``drain_background_tasks`` 等待或取消剩余任务，防止
“Event loop is closed” 噪音与复盘写入被中断。
"""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine

_BACKGROUND_TASKS: set[asyncio.Task[object]] = set()


def spawn(coro: Coroutine[object, object, object]) -> asyncio.Task[object]:
    """创建并登记一个后台任务；完成或取消时自动从集合中移除。"""

    task = asyncio.get_running_loop().create_task(coro)
    _BACKGROUND_TASKS.add(task)
    task.add_done_callback(_BACKGROUND_TASKS.discard)
    return task


async def drain_background_tasks(timeout: float = 5.0) -> None:
    """等待全部已登记的后台任务结束；超时则取消剩余的（应用关闭时调用）。"""

    if not _BACKGROUND_TASKS:
        return
    pending = list(_BACKGROUND_TASKS)
    _done, still = await asyncio.wait(pending, timeout=timeout)
    for task in still:
        task.cancel()
    if still:
        await asyncio.wait(still)
