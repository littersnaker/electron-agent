"""统一 Agent Runtime 使用的数据契约。

本模块只保存轻量数据结构，不执行网络、数据库或文件系统操作。把这些公共对象集中在一起，
可以避免 Runtime、Agent、Memory、Skill 与 Model Router 之间互相导入具体实现而形成循环依赖。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

RuntimeStatus = Literal["pending", "running", "completed", "failed", "cancelled"]


@dataclass(frozen=True, slots=True)
class RuntimeMessage:
    """保存一条经过 Runtime 规范化的聊天消息。"""

    role: str
    content: str


@dataclass(frozen=True, slots=True)
class RuntimeRequest:
    """描述一次交给统一 Runtime 的 Agent 请求。

    ``payload`` 保留原业务请求对象，使旧 Agent 能通过适配层继续工作；``credentials``
    使用 ``object`` 是因为 QA/Code 需要 LLM 凭证，而 Commerce 使用独立数据源凭证。
    具体适配器必须在执行前完成严格类型校验，Runtime 不读取凭证正文。
    """

    agent_id: str
    payload: object
    preferred_model_id: str
    credentials: object
    session_id: str
    project_id: str
    user_text: str
    messages: tuple[RuntimeMessage, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class RuntimeContext:
    """保存 Context Manager 构建出的最终上下文和可审计元数据。"""

    rendered: str
    token_budget: int
    estimated_tokens: int
    skill_ids: tuple[str, ...] = ()
    memory_ids: tuple[str, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class RuntimeTask:
    """保存 Runtime 内部任务的当前状态。"""

    id: str
    agent_id: str
    session_id: str
    project_id: str
    status: RuntimeStatus = "pending"
    error_message: str = ""
    event_count: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        """把任务转换成日志、测试和诊断接口可使用的稳定 JSON。"""

        # 显式逐项构造字典，避免将未来新增的内部字段无意暴露给前端。
        return {
            "id": self.id,
            "agentId": self.agent_id,
            "sessionId": self.session_id,
            "projectId": self.project_id,
            "status": self.status,
            "errorMessage": self.error_message,
            "eventCount": self.event_count,
            "metadata": dict(self.metadata),
        }
