"""Spill 落盘存储：超大工具输出写入工作区 .agent-data/spill/，按哈希幂等。"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

SPILL_SUBDIR = ".agent-data/spill"


def _hash_text(text: str) -> str:
    """返回内容 SHA-256 前 12 位，天然去重。"""

    return hashlib.sha256(text.encode("utf-8"), usedforsecurity=False).hexdigest()[:12]


class SpillStore:
    """把大段工具输出落盘，并返回稳定的相对路径定位符。"""

    def __init__(self, workspace_root: Path) -> None:
        self._root = Path(workspace_root)

    def _base_dir(self, session_id: str) -> Path:
        """spill 目录：<workspace>/.agent-data/spill/<session_id>/。"""

        directory = self._root / SPILL_SUBDIR / session_id
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def save(
        self,
        *,
        session_id: str,
        tool_name: str,
        content: str,
    ) -> dict[str, Any]:
        """落盘一段内容，返回定位信息（幂等：同内容只写一次）。"""

        text = str(content or "")
        digest = _hash_text(text)
        self._base_dir(session_id)  # 确保会话目录存在。
        relative = f"{SPILL_SUBDIR}/{session_id}/{digest}.txt"
        path = self._root / relative
        if not path.exists():
            path.write_text(text, encoding="utf-8")
        lines = text.count("\n") + 1 if text else 0
        return {
            "path": relative,
            "bytes": len(text.encode("utf-8")),
            "lines": lines,
            "tool": tool_name,
        }


__all__ = ["SpillStore", "SPILL_SUBDIR"]
