"""Checkpoint 状态压缩器。"""

from __future__ import annotations

import json
from typing import Any


class CheckpointCompressor:
    """限制通用 Checkpoint JSON 大小，并保留恢复所需关键字段。"""

    def compress(
        self,
        state: dict[str, Any],
        *,
        maximum_characters: int = 1_000_000,
    ) -> dict[str, Any]:
        """在不修改输入对象的前提下压缩超长文本字段。"""

        copied = self._truncate_value(state, maximum_string=100_000)
        serialized = json.dumps(copied, ensure_ascii=False)
        if len(serialized) <= maximum_characters:
            return copied if isinstance(copied, dict) else {}

        # 超过总预算时只保留恢复最关键的字段，并附带压缩标记供诊断。
        keys = ("taskId", "currentStep", "plan", "files", "summary", "codeLoop")
        compact = {key: copied[key] for key in keys if isinstance(copied, dict) and key in copied}
        compact["checkpointCompressed"] = True
        compact["originalCharacters"] = len(serialized)
        return compact

    def _truncate_value(self, value: Any, *, maximum_string: int) -> Any:
        """递归复制 JSON 值，并截断异常长字符串和列表。"""

        if isinstance(value, str):
            if len(value) <= maximum_string:
                return value
            return f"{value[:maximum_string]}\n（Checkpoint 文本已截断）"
        if isinstance(value, list):
            return [
                self._truncate_value(item, maximum_string=maximum_string)
                for item in value[:2_000]
            ]
        if isinstance(value, dict):
            return {
                str(key): self._truncate_value(item, maximum_string=maximum_string)
                for key, item in value.items()
            }
        return value
