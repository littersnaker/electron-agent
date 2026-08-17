"""Agent 适配器插件注册表。

适配器类通过 ``@register_adapter("adapter_name")`` 注册，模块被导入时自动
登记；新增 Agent 只需新增一个 adapter 文件 + 一份 ``agent.yaml``，不需要
修改注册表或 Runtime 代码。
"""

from __future__ import annotations

from typing import Callable, TypeVar, cast

from backend.services.agent.adapters.base import BaseAgent

T = TypeVar("T", bound=type)

_ADAPTERS: dict[str, type[BaseAgent]] = {}


def register_adapter(name: str) -> Callable[[T], T]:
    """返回一个类装饰器：把适配器类按名称登记到全局注册表。"""

    def decorator(cls: T) -> T:
        _ADAPTERS[name] = cast(type[BaseAgent], cls)
        return cls

    return decorator


def get_adapter_class(name: str) -> type[BaseAgent] | None:
    """按 adapter 名称返回适配器类；未注册返回 None。"""

    return _ADAPTERS.get(name)


def registered_adapter_names() -> list[str]:
    """返回当前已注册的全部 adapter 名称（排序，便于诊断）。"""

    return sorted(_ADAPTERS)


__all__ = [
    "get_adapter_class",
    "register_adapter",
    "registered_adapter_names",
]
