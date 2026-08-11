"""Semantic Memory：保存用户知识和项目知识。"""

from backend.services.memory.sqlite_store import SQLiteMemoryStore


class SemanticMemoryStore(SQLiteMemoryStore):
    """固定使用 ``semantic`` 类型的 SQLite Memory Store。"""

    def __init__(self) -> None:
        """初始化 Semantic Memory。"""

        super().__init__("semantic")
