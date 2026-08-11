"""Skills 系统使用的数据结构。"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal

SkillScope = Literal["system", "project", "user", "task"]


@dataclass(frozen=True, slots=True)
class SkillDefinition:
    """保存一个经过校验、可注入 Runtime 的 Skill。"""

    id: str
    name: str
    version: str
    description: str
    scope: SkillScope
    prompt: str
    tools: tuple[str, ...]
    memory: tuple[str, ...]
    permissions: dict[str, Any]
    requires_reasoning: bool
    source_path: Path
    tags: tuple[str, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)
