"""Task Memory：保存当前任务和可恢复状态摘要。"""

from backend.services.memory.sqlite_store import SQLiteMemoryStore


class TaskMemoryStore(SQLiteMemoryStore):
    """固定使用 ``task`` 类型的 SQLite Memory Store。"""

    def __init__(self) -> None:
        """初始化 Task Memory。"""

        super().__init__("task")
