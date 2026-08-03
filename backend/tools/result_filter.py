"""Tool Gateway 结果过滤器。"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any

SENSITIVE_KEY_PARTS = ("api_key", "apikey", "token", "secret", "password", "authorization")
MAXIMUM_STRING_CHARACTERS = 100_000
MAXIMUM_LIST_ITEMS = 2_000


class ToolResultFilter:
    """在工具结果进入模型上下文前执行脱敏和大小限制。"""

    def filter(self, value: Any) -> Any:
        """递归转换工具结果，保留结构但隐藏敏感键值。"""

        if is_dataclass(value) and not isinstance(value, type):
            return self.filter(asdict(value))
        if isinstance(value, dict):
            filtered: dict[str, Any] = {}
            for key, item in value.items():
                normalized_key = str(key)
                lowered = normalized_key.lower()
                if any(part in lowered for part in SENSITIVE_KEY_PARTS):
                    filtered[normalized_key] = "[REDACTED]"
                else:
                    filtered[normalized_key] = self.filter(item)
            return filtered
        if isinstance(value, (list, tuple, set, frozenset)):
            items = list(value)
            return [self.filter(item) for item in items[:MAXIMUM_LIST_ITEMS]]
        if isinstance(value, str):
            if len(value) <= MAXIMUM_STRING_CHARACTERS:
                return value
            return f"{value[:MAXIMUM_STRING_CHARACTERS]}\n（工具结果已截断）"
        if value is None or isinstance(value, (bool, int, float)):
            return value
        return str(value)
