"""Software Factory 在统一 Tool Gateway 中的注册与执行。"""

from __future__ import annotations

import asyncio
from typing import Any

from backend.services.software_factory import SOFTWARE_FACTORY
from backend.services.tools.contracts import ToolDefinition, ToolExecutionContext
from backend.services.tools.gateway import TOOL_GATEWAY

_REGISTERED = False


async def _plan(
    context: ToolExecutionContext,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """分析真实项目并返回不写文件的 Software Factory 计划。"""

    # plan/generate/validate 内含 rglob、read_text、write_text 等重 I/O，
    # 放到 worker 线程执行，避免在 Agent 主循环的 async 路径上阻塞事件循环。
    return await asyncio.to_thread(
        SOFTWARE_FACTORY.plan,
        root=context.workspace_root,
        request_text=_request_text(arguments),
        domain_id=_domain_id(arguments),
        output_root=str(arguments.get("output_root") or ""),
        mock_count=_mock_count(arguments),
    )


async def _generate(
    context: ToolExecutionContext,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """生成领域、OpenAPI、Mock 和前端数据源文件。"""

    return await asyncio.to_thread(
        SOFTWARE_FACTORY.generate,
        root=context.workspace_root,
        request_text=_request_text(arguments),
        domain_id=_domain_id(arguments),
        output_root=str(arguments.get("output_root") or ""),
        mock_count=_mock_count(arguments),
        overwrite=bool(arguments.get("overwrite")),
    )


async def _validate(
    context: ToolExecutionContext,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """校验已生成文件是否缺失、漂移或契约不一致。"""

    output_root = str(arguments.get("output_root") or "").strip()
    if not output_root:
        raise ValueError("software_factory.validate 缺少 output_root")
    return await asyncio.to_thread(
        SOFTWARE_FACTORY.validate,
        root=context.workspace_root,
        output_root=output_root,
    )


async def _manifest(
    context: ToolExecutionContext,
    arguments: dict[str, Any],
) -> dict[str, Any]:
    """确定性重建根目录 manifest（LLM 只触发，不手拼 JSON/算哈希）。"""

    output_root = str(arguments.get("output_root") or "").strip()
    if not output_root:
        raise ValueError("software_factory.manifest 缺少 output_root")
    return await asyncio.to_thread(
        SOFTWARE_FACTORY.regenerate_manifest,
        root=context.workspace_root,
        output_root=output_root,
    )


def register_software_factory_tools() -> None:
    """幂等注册计划、生成和校验三个高层工程工具。"""

    global _REGISTERED
    if _REGISTERED:
        return

    definitions = (
        ToolDefinition(
            "software_factory.plan",
            "分析项目并规划领域模型、Mock、API 契约和前端数据层",
            "read",
            _plan,
            60.0,
            1,
        ),
        ToolDefinition(
            "software_factory.generate",
            "生成电商领域契约、Mock、API Client 和可切换数据源",
            "write",
            _generate,
            180.0,
            0,
        ),
        ToolDefinition(
            "software_factory.validate",
            "校验 Software Factory 文件完整性和契约一致性",
            "read",
            _validate,
            60.0,
            1,
        ),
        ToolDefinition(
            "software_factory.manifest",
            "确定性重建 software-factory.manifest.json（扫描目录计算 SHA-256，LLM 无需手拼 JSON）",
            "write",
            _manifest,
            180.0,
            0,
        ),
    )
    for definition in definitions:
        TOOL_GATEWAY.register(definition)
    _REGISTERED = True


def _request_text(arguments: dict[str, Any]) -> str:
    """读取并限制工具参数中的原始业务需求。"""

    request_text = str(arguments.get("request_text") or "").strip()
    if not request_text:
        raise ValueError("Software Factory 缺少 request_text")
    return request_text[:20_000]


def _domain_id(arguments: dict[str, Any]) -> str:
    """返回规范化领域 ID。"""

    return str(arguments.get("domain_id") or "commerce-miniapp").strip().lower()


def _mock_count(arguments: dict[str, Any]) -> int:
    """把 Mock 数量限制在可控范围。"""

    try:
        value = int(arguments.get("mock_count") or 12)
    except (TypeError, ValueError):
        value = 12
    return max(3, min(value, 100))
