"""统一 Tool Gateway。"""

from __future__ import annotations

import asyncio
import logging

from backend.services.tools.contracts import (
    ToolDefinition,
    ToolExecutionContext,
    ToolExecutionResult,
    ToolRequest,
)
from backend.services.tools.result_filter import ToolResultFilter
from backend.services.tools.validator import ToolValidator

LOGGER = logging.getLogger(__name__)


class ToolGateway:
    """集中处理工具注册、权限、超时、重试、日志和结果过滤。"""

    def __init__(self) -> None:
        """创建空工具注册表和通用校验、过滤组件。"""

        self._definitions: dict[str, ToolDefinition] = {}
        self._validator = ToolValidator()
        self._result_filter = ToolResultFilter()

    def register(self, definition: ToolDefinition) -> None:
        """注册工具；相同名称只能注册完全同一个处理器。"""

        existing = self._definitions.get(definition.name)
        if existing is not None:
            if existing.handler is definition.handler:
                return
            raise ValueError(f"Tool 名称重复：{definition.name}")
        self._definitions[definition.name] = definition

    async def execute(
        self,
        request: ToolRequest,
        *,
        context: ToolExecutionContext,
    ) -> ToolExecutionResult:
        """校验并执行工具，在只读工具失败时按配置进行有限重试。"""

        definition = self._definitions.get(request.name)
        if definition is None:
            raise KeyError(f"未注册 Tool：{request.name}")
        self._validator.validate(definition=definition, request=request, context=context)

        attempts = 0
        last_error: Exception | None = None
        maximum_attempts = 1 + max(0, definition.maximum_retries)
        while attempts < maximum_attempts:
            attempts += 1
            try:
                LOGGER.info(
                    "Tool 开始执行 name=%s agent=%s task=%s attempt=%s",
                    definition.name,
                    context.agent_id,
                    context.task_id,
                    attempts,
                )
                raw = await asyncio.wait_for(
                    definition.handler(context, request.arguments),
                    timeout=max(1.0, min(definition.timeout_seconds, 600.0)),
                )
                filtered = self._result_filter.filter(raw)
                LOGGER.info(
                    "Tool 执行完成 name=%s agent=%s attempt=%s",
                    definition.name,
                    context.agent_id,
                    attempts,
                )
                return ToolExecutionResult(definition.name, raw, filtered, attempts)
            except Exception as exc:
                last_error = exc
                LOGGER.warning(
                    "Tool 执行失败 name=%s agent=%s attempt=%s error=%s",
                    definition.name,
                    context.agent_id,
                    attempts,
                    exc,
                )
                if attempts >= maximum_attempts:
                    break
                # 短暂让出事件循环；写入工具默认不配置重试，避免重复副作用。
                await asyncio.sleep(min(0.25 * attempts, 1.0))

        if last_error is not None:
            raise last_error
        raise RuntimeError(f"Tool {request.name} 未执行")

    def catalog(self) -> list[dict[str, object]]:
        """返回诊断页面可公开的工具目录。"""

        return [
            {
                "name": definition.name,
                "description": definition.description,
                "permission": definition.permission,
                "timeoutSeconds": definition.timeout_seconds,
                "maximumRetries": definition.maximum_retries,
            }
            for definition in sorted(self._definitions.values(), key=lambda item: item.name)
        ]


TOOL_GATEWAY = ToolGateway()
