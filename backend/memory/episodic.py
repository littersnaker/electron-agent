"""Episodic Memory：保存会话和历史执行摘要。"""

from backend.memory.sqlite_store import SQLiteMemoryStore


class EpisodicMemoryStore(SQLiteMemoryStore):
    """固定使用 ``episodic`` 类型的 SQLite Memory Store。"""

    def __init__(self) -> None:
        """初始化 Episodic Memory。"""

        super().__init__("episodic")
