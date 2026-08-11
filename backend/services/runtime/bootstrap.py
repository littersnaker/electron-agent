"""创建应用级统一 Agent Runtime 单例。"""

from __future__ import annotations

from pathlib import Path

from backend.core.config import get_settings
from backend.services.runtime.agent_registry import AgentRegistry
from backend.services.runtime.agent_runtime import AgentRuntime
from backend.services.skills import SkillRegistry

# bootstrap 位于 backend/services/runtime/，parents[3] 即项目根目录
# （agents/、skills/ 等配置目录都在项目根）。
PROJECT_ROOT = Path(__file__).resolve().parents[3]


def create_runtime() -> AgentRuntime:
    """根据项目目录和应用数据目录创建 Runtime。"""

    settings = get_settings()
    skill_roots = {
        "system": (PROJECT_ROOT / "skills" / "system",),
        "project": (PROJECT_ROOT / "skills" / "project",),
        "user": (settings.data_dir / "skills" / "user",),
        "task": (settings.data_dir / "skills" / "task",),
    }
    return AgentRuntime(
        agent_registry=AgentRegistry(PROJECT_ROOT / "agents"),
        skill_registry=SkillRegistry(skill_roots),
    )


RUNTIME = create_runtime()
