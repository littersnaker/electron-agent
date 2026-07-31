"""Code Agent 请求分类模块。"""

from __future__ import annotations

import re
from typing import Literal

RequestMode = Literal["workspace_info", "read_only", "code_change", "interactive_reply"]


WRITE_PATTERNS = (
    r"\b(add|create|implement|fix|modify|update|delete|rename|refactor|write)\b",
    r"新增|创建|实现|修复|修改|更新|删除|重命名|重构|写入|替换|迁移",
)


READ_PATTERNS = (
    r"\b(explain|analyze|review|find|search|where|why|how)\b",
    r"解释|分析|审查|查找|搜索|在哪|为什么|怎么|阅读|总结",
)


WORKSPACE_PATTERNS = (
    r"项目路径|工作区路径|当前项目|项目名称|绑定目录",
    r"\b(workspace|project path|working directory)\b",
)


def classify_request(text: str) -> RequestMode:
    """用可解释的关键词规则判断请求类型。"""

    normalized = text.strip().lower()
    if normalized.startswith("[interactive_reply]"):
        return "interactive_reply"
    if any(re.search(pattern, normalized, re.IGNORECASE) for pattern in WORKSPACE_PATTERNS):
        return "workspace_info"
    if any(re.search(pattern, normalized, re.IGNORECASE) for pattern in WRITE_PATTERNS):
        return "code_change"
    if any(re.search(pattern, normalized, re.IGNORECASE) for pattern in READ_PATTERNS):
        return "read_only"
    return "read_only"
