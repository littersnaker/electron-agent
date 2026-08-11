"""从配置文件加载可插拔 Agent，并创建安全的适配器实例。"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from backend.services.agent.adapters.base import BaseAgent
from backend.services.agent.adapters.coding import CodeAgentAdapter
from backend.services.agent.adapters.commerce import CommerceAgentAdapter
from backend.services.agent.adapters.media import MediaAgentAdapter
from backend.services.agent.adapters.qa import QAAgentAdapter

AgentFactory = Callable[[], BaseAgent]


@dataclass(frozen=True, slots=True)
class AgentConfig:
    """保存 ``agent.yaml`` 中经过校验的 Agent 配置。"""

    id: str
    name: str
    adapter: str
    planner: str
    skills: tuple[str, ...] = ()
    tools: tuple[str, ...] = ()
    memory: tuple[str, ...] = ()
    output_schema: str = "stream"
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RegisteredAgent:
    """把 Agent 配置与运行时适配器组合成一个注册项。"""

    config: AgentConfig
    adapter: BaseAgent


class AgentRegistry:
    """扫描 Agent 配置，并限制可实例化的适配器类型。"""

    def __init__(self, config_root: Path) -> None:
        """保存配置目录并初始化白名单适配器工厂。"""

        self._config_root = config_root.resolve()
        self._agents: dict[str, RegisteredAgent] = {}

        # 配置文件不能直接导入任意 Python 路径，必须映射到代码中明确批准的工厂。
        self._factories: dict[str, AgentFactory] = {
            "legacy_code_agent": CodeAgentAdapter,
            "qa_agent": QAAgentAdapter,
            "commerce_agent": CommerceAgentAdapter,
            "media_agent": MediaAgentAdapter,
        }

    def load(self) -> None:
        """扫描全部 ``agent.yaml``，并用新结果原子替换旧注册表。"""

        loaded: dict[str, RegisteredAgent] = {}
        if not self._config_root.is_dir():
            raise FileNotFoundError(f"Agent 配置目录不存在：{self._config_root}")

        for path in sorted(self._config_root.rglob("agent.yaml")):
            config = self._load_config(path)
            if config.id in loaded:
                raise ValueError(f"Agent ID 重复：{config.id}")
            factory = self._factories.get(config.adapter)
            if factory is None:
                raise ValueError(f"Agent {config.id} 使用了未批准适配器：{config.adapter}")
            loaded[config.id] = RegisteredAgent(config=config, adapter=factory())

        if not loaded:
            raise ValueError("没有找到任何可用 Agent 配置")
        self._agents = loaded

    def get(self, agent_id: str) -> RegisteredAgent:
        """按 ID 返回 Agent；未注册时抛出包含可用列表的错误。"""

        normalized = agent_id.strip().lower()
        agent = self._agents.get(normalized)
        if agent is None:
            available = ", ".join(sorted(self._agents)) or "无"
            raise KeyError(f"未注册 Agent：{agent_id}；当前可用：{available}")
        return agent

    def catalog(self) -> list[dict[str, object]]:
        """返回诊断接口可以公开的 Agent 配置摘要。"""

        return [
            {
                "id": item.config.id,
                "name": item.config.name,
                "planner": item.config.planner,
                "skills": list(item.config.skills),
                "tools": list(item.config.tools),
                "memory": list(item.config.memory),
                "outputSchema": item.config.output_schema,
            }
            for item in self._agents.values()
        ]

    def _load_config(self, path: Path) -> AgentConfig:
        """读取并校验一个 Agent YAML 文件。"""

        raw = yaml.safe_load(path.read_text("utf-8"))
        if not isinstance(raw, dict):
            raise ValueError(f"Agent 配置必须是对象：{path}")

        identifier = str(raw.get("id") or "").strip().lower()
        name = str(raw.get("name") or identifier).strip()
        adapter = str(raw.get("adapter") or "").strip()
        planner = str(raw.get("planner") or "default").strip()
        if not identifier or not adapter:
            raise ValueError(f"Agent 配置缺少 id 或 adapter：{path}")

        # 所有列表字段都转换成去空白的字符串元组，确保后续行为稳定可预测。
        return AgentConfig(
            id=identifier,
            name=name,
            adapter=adapter,
            planner=planner,
            skills=self._strings(raw.get("skills")),
            tools=self._strings(raw.get("tools")),
            memory=self._strings(raw.get("memory")),
            output_schema=str(raw.get("output_schema") or "stream").strip(),
            metadata=dict(raw.get("metadata") or {}),
        )

    def _strings(self, value: object) -> tuple[str, ...]:
        """把 YAML 列表安全转换成去重字符串元组。"""

        if not isinstance(value, list):
            return ()
        cleaned = [str(item).strip() for item in value if str(item).strip()]
        return tuple(dict.fromkeys(cleaned))
