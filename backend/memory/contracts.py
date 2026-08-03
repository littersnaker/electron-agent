"""统一 Memory 系统的数据结构和接口。"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol


@dataclass(frozen=True, slots=True)
class MemoryRecord:
    """表示一条可检索的 Agent 记忆。"""

    id: str
    memory_type: str
    scope_id: str
    content: str
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""
    expires_at: str | None = None


class MemoryStore(Protocol):
    """定义所有 Memory Store 必须实现的统一接口。"""

    async def search(
        self,
        *,
        query: str,
        scope_ids: tuple[str, ...],
        top_k: int,
    ) -> list[MemoryRecord]:
        """按查询词和作用域检索记忆。"""

        ...

    async def save(
        self,
        *,
        scope_id: str,
        content: str,
        metadata: dict[str, Any] | None = None,
        expires_at: str | None = None,
    ) -> MemoryRecord:
        """保存一条记忆并返回完整记录。"""

        ...
