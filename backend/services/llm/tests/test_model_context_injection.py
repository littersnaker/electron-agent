"""网关模型身份注入测试：Agent 应能在上下文中自知当前实际模型。"""

from __future__ import annotations

from backend.services.llm.catalog import ModelDefinition
from backend.services.llm.gateway import LlmGateway
from backend.services.llm.types import LlmMessage


def _model() -> ModelDefinition:
    return ModelDefinition(
        id="deepseek:deepseek-v4-flash",
        provider="deepseek",
        model="deepseek-v4-flash",
        name="DeepSeek V4 Flash",
        description="",
        capabilities=("text", "stream"),
    )


def test_inject_appends_to_first_system_message() -> None:
    """存在 system 消息时应把模型信息追加到其末尾。"""

    messages = [
        LlmMessage("system", "你是代码代理"),
        LlmMessage("user", "帮我改 bug"),
    ]
    result = LlmGateway._inject_model_context(_model(), messages)

    assert "DeepSeek V4 Flash" in result[0].content
    assert "deepseek/deepseek-v4-flash" in result[0].content
    assert "你是代码代理" in result[0].content
    assert result[1].content == "帮我改 bug"
    # 不污染调用方的原始列表。
    assert "DeepSeek V4 Flash" not in messages[0].content
    assert len(result) == 2


def test_inject_inserts_system_when_missing() -> None:
    """没有 system 消息时应插入一条模型身份 system 消息。"""

    messages = [LlmMessage("user", "你好")]
    result = LlmGateway._inject_model_context(_model(), messages)

    assert result[0].role == "system"
    assert "deepseek-v4-flash" in result[0].content
    assert result[1].content == "你好"


def test_inject_only_first_system_message_gets_note() -> None:
    """多条 system 消息时只注入第一条，避免重复。"""

    messages = [
        LlmMessage("system", "A"),
        LlmMessage("system", "B"),
        LlmMessage("user", "C"),
    ]
    result = LlmGateway._inject_model_context(_model(), messages)

    assert "DeepSeek V4 Flash" in result[0].content
    assert result[1].content == "B"
    assert result[2].content == "C"
