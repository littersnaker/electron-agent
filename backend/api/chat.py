"""Code Agent 旧导入路径兼容层。

新代码请从 ``backend.api.code`` 导入路由；保留本文件是为了避免第三方扩展在升级时失效。
"""

from backend.api.code import router

__all__ = ["router"]
