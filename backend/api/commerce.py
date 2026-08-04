"""Commerce Agent 旧导入路径兼容层。

新代码请从 ``backend.api.commerce`` 导入路由；保留本文件是为了平滑迁移已有扩展。
"""

from backend.api.commerce import router

__all__ = ["router"]
