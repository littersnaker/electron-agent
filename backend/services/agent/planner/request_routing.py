"""Code Agent 单轮请求路由辅助。

本模块把会话续写识别、有效任务恢复和真实工具能力计算集中起来，避免主服务文件继续膨胀，
也确保自动编辑与全自动模式不会因为简短追问意外退回只读 Agent。
"""

from __future__ import annotations

from dataclasses import dataclass

from backend.schemas.chat import ChatRequest
from backend.services.agent.planner.classifier import (
    RequestMode,
    classify_request,
    resolve_effective_code_request,
)
from backend.services.agent.shared.tool_registry import tool_names_for_mode


@dataclass(frozen=True, slots=True)
class RoutedCodeRequest:
    """保存本轮请求分类、恢复后的任务文本和实际工具名称。"""

    mode: RequestMode
    effective_text: str
    tool_names: tuple[str, ...]


def route_code_request(body: ChatRequest, user_text: str) -> RoutedCodeRequest:
    """结合最近用户消息与执行模式生成稳定的 Code Agent 路由结果。"""

    recent_user_messages = [
        message.content.strip()
        for message in body.messages[-10:]
        if message.role == "user" and message.content.strip()
    ]
    mode = classify_request(
        user_text,
        agent_mode=body.agent_mode,
        conversation_text="\n".join(recent_user_messages),
    )
    effective_text = (
        resolve_effective_code_request(user_text, recent_user_messages)
        if mode == "code_change"
        else user_text
    )
    execution_mode = body.agent_mode if body.agent_mode != "suggest" else "auto_edit"
    tools = tool_names_for_mode(
        read_only=mode != "code_change",
        execution_mode=execution_mode,
    )
    return RoutedCodeRequest(mode, effective_text, tools)


__all__ = ["RoutedCodeRequest", "route_code_request"]
