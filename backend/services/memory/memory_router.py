"""所有 Agent 共用的 Memory Router。"""

from __future__ import annotations

from typing import Any

from backend.memory.contracts import MemoryRecord, MemoryStore
from backend.memory.episodic import EpisodicMemoryStore
from backend.memory.semantic import SemanticMemoryStore
from backend.memory.task import TaskMemoryStore


class MemoryRouter:
    """按 Agent 配置选择 Memory Store，并合并检索结果。"""

    def __init__(self) -> None:
        """注册系统内置的三类 Memory Store。"""

        self._stores: dict[str, MemoryStore] = {
            "episodic": EpisodicMemoryStore(),
            "semantic": SemanticMemoryStore(),
            "task": TaskMemoryStore(),
        }

    async def search(
        self,
        *,
        memory_types: tuple[str, ...],
        query: str,
        scope_ids: tuple[str, ...],
        top_k: int = 8,
    ) -> list[MemoryRecord]:
        """从多个 Store 检索，并按更新时间合并去重。"""

        records: list[MemoryRecord] = []
        per_store = max(1, top_k)
        for memory_type in memory_types:
            store = self._stores.get(memory_type)
            if store is None:
                raise KeyError(f"未注册 Memory 类型：{memory_type}")
            records.extend(
                await store.search(query=query, scope_ids=scope_ids, top_k=per_store)
            )

        # 同一 ID 只保留一条，再按更新时间倒序截取总上限。
        unique = {record.id: record for record in records}
        ordered = sorted(unique.values(), key=lambda item: item.updated_at, reverse=True)
        return ordered[: max(1, top_k)]

    async def save_execution_summary(
        self,
        *,
        session_id: str,
        project_id: str,
        agent_id: str,
        request_text: str,
        status: str,
        event_count: int,
        result_summary: str = "",
        metadata: dict[str, Any] | None = None,
    ) -> MemoryRecord:
        """把一次 Runtime 执行摘要保存为 Episodic Memory。"""

        scope_id = project_id.strip() or session_id.strip() or "global"
        content_parts = [
            f"Agent={agent_id}\n"
            f"Status={status}\n"
            f"Request={request_text[:8_000]}\n"
            f"EventCount={event_count}",
        ]
        normalized_summary = result_summary.strip()[:4_000]
        if normalized_summary:
            content_parts.append(f"Summary={normalized_summary}")
        store = self._stores["episodic"]
        return await store.save(
            scope_id=scope_id,
            content="\n".join(content_parts),
            metadata={
                "sessionId": session_id,
                "projectId": project_id,
                "agentId": agent_id,
                "status": status,
                "resultSummary": normalized_summary,
                **dict(metadata or {}),
            },
        )

    def get_store(self, memory_type: str) -> MemoryStore:
        """返回指定 Store，供明确的业务写入和测试使用。"""

        store = self._stores.get(memory_type)
        if store is None:
            raise KeyError(f"未注册 Memory 类型：{memory_type}")
        return store
