"""Agent 配置注册表测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.services.runtime.agent_registry import AgentRegistry


def test_agent_registry_loads_approved_adapter(tmp_path: Path) -> None:
    """合法配置应创建白名单中的旧 Code Agent 适配器。"""

    agent_root = tmp_path / "coding"
    agent_root.mkdir(parents=True)
    (agent_root / "agent.yaml").write_text(
        "\n".join(
            (
                "id: coding",
                "name: Coding Agent",
                "adapter: legacy_code_agent",
                "planner: software_engineering",
                "skills:",
                "  - workspace-code-agent",
                "tools:",
                "  - workspace.read",
                "memory:",
                "  - task",
            )
        ),
        "utf-8",
    )

    registry = AgentRegistry(tmp_path)
    registry.load()

    registered = registry.get("coding")
    assert registered.config.planner == "software_engineering"
    assert registered.config.skills == ("workspace-code-agent",)
    assert registered.adapter.agent_id == "coding"


def test_agent_registry_rejects_unregistered_python_adapter(tmp_path: Path) -> None:
    """配置文件不能通过任意导入路径实例化未注册代码。"""

    agent_root = tmp_path / "unsafe"
    agent_root.mkdir(parents=True)
    (agent_root / "agent.yaml").write_text(
        "\n".join(
            (
                "id: unsafe",
                "adapter: os.system",
                "planner: default",
            )
        ),
        "utf-8",
    )

    registry = AgentRegistry(tmp_path)
    with pytest.raises(ValueError, match="未注册适配器"):
        registry.load()
