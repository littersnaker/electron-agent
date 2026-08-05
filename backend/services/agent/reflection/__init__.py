"""复盘循环：任务完成后异步提取可复用知识，写入 SQLite 记忆库。

设计约束（与用户确认）：
- 复盘绝不阻塞主流程：异步、失败静默跳过；
- 默认仅当用户配置了 DeepSeek API Key 时才运行，复盘模型可在前端设置；
- 复盘输出必须通过 Pydantic 校验 + 置信度过滤，格式错/低置信直接丢弃；
- 只写 semantic 记忆（facts/lessons），技能更新走审批门（pending）；
- 去重、容量上限、过期淘汰，避免无脑存储。
"""

from backend.services.agent.reflection.runner import (
    schedule_work_review,
)

__all__ = ["schedule_work_review"]
