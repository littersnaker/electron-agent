"""Work Context 隔离与项目检索上下文的统一入口。

本包同时暴露 Work 级隔离上下文能力和旧版项目索引检索函数，避免
``context.py`` 与 ``context/`` 同名时 Python 优先加载包而导致导入失败。
"""

from backend.services.agent.context.context_compactor import (
    MAX_TOOL_OUTPUT_TOKEN,
    MAX_WORK_CONTEXT_TOKEN,
    CompactionResult,
    ContextCompactor,
)
from backend.services.agent.context.context_store import ContextStore
from backend.services.agent.context.work_context import WorkContext
from backend.services.agent.planner.project_context import (
    _fallback_overview_files,
    ensure_context,
    render_context,
)

__all__ = [
    "ContextCompactor",
    "CompactionResult",
    "ContextStore",
    "WorkContext",
    "MAX_TOOL_OUTPUT_TOKEN",
    "MAX_WORK_CONTEXT_TOKEN",
    "_fallback_overview_files",
    "ensure_context",
    "render_context",
]
