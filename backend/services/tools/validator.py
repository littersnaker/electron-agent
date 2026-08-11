"""Tool Gateway 请求校验器。"""

from __future__ import annotations

import json
from pathlib import Path

from backend.services.tools.contracts import ToolDefinition, ToolExecutionContext, ToolRequest
from backend.utils.sensitive_paths import is_sensitive_workspace_path

MAXIMUM_ARGUMENT_CHARACTERS = 2_500_000


class ToolValidator:
    """统一检查工具权限、工作区和参数大小。"""

    def validate(
        self,
        *,
        definition: ToolDefinition,
        request: ToolRequest,
        context: ToolExecutionContext,
    ) -> None:
        """在调用工具实现前完成所有通用校验。"""

        if definition.permission not in context.allowed_permissions:
            raise PermissionError(
                f"Agent {context.agent_id} 没有工具 {definition.name} 的 "
                f"{definition.permission} 权限"
            )

        root = context.workspace_root.resolve()
        if not root.is_dir():
            raise ValueError(f"工具工作区不存在或不是目录：{root}")
        if request.name != definition.name:
            raise ValueError("ToolRequest 与 ToolDefinition 名称不一致")

        # 使用 default=str 只用于计算大小，不把不可序列化对象转换后传给工具实现。
        size = len(json.dumps(request.arguments, ensure_ascii=False, default=str))
        if size > MAXIMUM_ARGUMENT_CHARACTERS:
            raise ValueError(f"工具参数超过 {MAXIMUM_ARGUMENT_CHARACTERS} 字符限制")

    def validate_relative_paths(self, root: Path, paths: list[str]) -> None:
        """校验一组路径都位于工作区内且不指向敏感环境文件。"""

        resolved_root = root.resolve()
        for relative in paths:
            normalized = relative.replace("\\", "/").strip().strip("/")
            if not normalized:
                raise ValueError("工具路径不能为空")
            if is_sensitive_workspace_path(normalized):
                raise ValueError(f"禁止访问敏感配置文件：{relative}")
            target = (resolved_root / normalized).resolve()
            if resolved_root not in target.parents and target != resolved_root:
                raise ValueError(f"工具路径越出工作区：{relative}")
