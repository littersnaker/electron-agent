"""可插拔 Agent 适配器包。

导入本包会加载全部内置 adapter 模块（触发 ``@register_adapter`` 装饰器），
保证 ``registry`` 在任何消费方读取前已包含全部适配器。
"""

from backend.services.agent.adapters import (  # noqa: F401
    coding,
    commerce,
    image,
    media,
    qa,
)

__all__ = ["coding", "commerce", "image", "media", "qa"]
