"""RAG 自动增量索引轮询服务。

不引入 watchdog 原生依赖（避免 PyInstaller 打包问题）：每 ``INDEX_POLL_SECONDS``
秒扫描一次项目与知识库，由各索引函数按 content_hash 只重向量化变更内容。
上传/删除接口内已直接触发对应索引，轮询只负责"文件被外部改动"这类漏网事件。
"""

from __future__ import annotations

import asyncio
import logging
import os

from backend.services.embeddings.knowledge import index_knowledge_base
from backend.services.workspace.database import open_database
from backend.services.workspace.indexer import index_project

LOGGER = logging.getLogger(__name__)

POLL_SECONDS = max(5.0, float(os.getenv("INDEX_POLL_SECONDS", "30")))


class IndexWatcher:
    """启动一个后台任务，周期执行项目/知识库差量索引。"""

    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._stop: asyncio.Event | None = None

    def start(self) -> None:
        """在应用事件循环中启动轮询任务（幂等）。"""

        if self._task is not None:
            return
        # Event 必须在启动时创建，绑定当前事件循环（测试里每个 TestClient
        # 都有独立 loop，模块级创建会导致 "bound to a different event loop"）。
        self._stop = asyncio.Event()
        self._task = asyncio.create_task(self._loop(), name="rag-index-watcher")
        LOGGER.info("RAG 增量索引 watcher 已启动（每 %.0f 秒）", POLL_SECONDS)

    async def stop(self) -> None:
        """停止轮询任务并等待退出。"""

        if self._stop is not None:
            self._stop.set()
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _loop(self) -> None:
        """轮询主循环：执行一次差量索引后等待下一个周期。"""

        while self._stop is not None and not self._stop.is_set():
            try:
                await self._tick()
            except Exception:  # noqa: BLE001 - 单轮失败不终止 watcher
                LOGGER.exception("RAG 增量索引轮询失败")
            try:
                if self._stop is not None:
                    await asyncio.wait_for(self._stop.wait(), timeout=POLL_SECONDS)
            except asyncio.TimeoutError:
                pass

    async def _tick(self) -> None:
        """对所有项目与知识库执行一次差量索引（内部各自按哈希跳过未变更）。"""

        async with open_database() as connection:
            cursor = await connection.execute("SELECT id FROM projects")
            project_ids = [str(row["id"]) for row in await cursor.fetchall()]
        for project_id in project_ids:
            try:
                await index_project(project_id)
            except Exception:  # noqa: BLE001 - 单项目失败不影响其他项目
                LOGGER.exception("项目 %s 增量索引失败", project_id)
        await index_knowledge_base()


WATCHER = IndexWatcher()


__all__ = ["IndexWatcher", "WATCHER", "POLL_SECONDS"]
