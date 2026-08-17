"""Agent 适配器插件注册表测试。"""

from __future__ import annotations

from backend.services.agent.adapters import coding, commerce, image, media, qa  # noqa: F401
from backend.services.agent.adapters.registry import (
    get_adapter_class,
    register_adapter,
    registered_adapter_names,
)


def test_builtin_adapters_registered_on_import() -> None:
    """导入适配器包即完成 5 个内置 adapter 的注册。"""

    assert get_adapter_class("legacy_code_agent") is not None
    assert get_adapter_class("qa_agent") is not None
    assert get_adapter_class("commerce_agent") is not None
    assert get_adapter_class("media_agent") is not None
    assert get_adapter_class("image_agent") is not None


def test_plugin_adapter_registers_without_registry_edit() -> None:
    """新增 adapter 只需装饰器注册，不改注册表代码。"""

    @register_adapter("mock_plugin_agent")
    class MockPluginAdapter:
        agent_id = "mock"

        async def stream(self, **kwargs):  # noqa: ANN001
            yield ""

    assert get_adapter_class("mock_plugin_agent") is MockPluginAdapter
    assert "mock_plugin_agent" in registered_adapter_names()
    # 插件注册不影响既有适配器
    assert "qa_agent" in registered_adapter_names()


def test_unknown_adapter_returns_none() -> None:
    """未注册的 adapter 名称返回 None，由注册表调用方给出可读错误。"""

    assert get_adapter_class("does_not_exist") is None
