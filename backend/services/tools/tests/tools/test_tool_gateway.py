"""Tool Gateway 权限与 Coding 工具测试。"""

from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest

from backend.services.agent.shared.workspace_tools import ReadBatchResult
from backend.services.tools.code_tools import execute_code_tool, register_code_tools
from backend.services.tools.contracts import ToolExecutionContext, ToolRequest
from backend.services.tools.gateway import TOOL_GATEWAY


@pytest.mark.asyncio
async def test_code_tools_search_read_and_inspect(tmp_path: Path) -> None:
    """搜索、读取和 AST 分析都应通过 Tool Gateway 返回真实结果。"""

    source = tmp_path / "sample.py"
    source.write_text(
        '"""示例。"""\n\n'
        "def helper() -> str:\n"
        '    """返回文本。"""\n\n'
        '    return "ok"\n\n'
        "def main() -> str:\n"
        '    """调用 helper。"""\n\n'
        "    return helper()\n",
        "utf-8",
    )

    search = await execute_code_tool(
        "workspace.search",
        root=tmp_path,
        arguments={"query": "helper"},
        permissions={"read"},
        agent_id="test-agent",
    )
    read = cast(
        ReadBatchResult,
        await execute_code_tool(
            "workspace.read",
            root=tmp_path,
            arguments={"paths": ["sample.py"]},
            permissions={"read"},
            agent_id="test-agent",
        ),
    )
    inspection = await execute_code_tool(
        "code.inspect",
        root=tmp_path,
        arguments={"paths": ["sample.py"], "query": "main"},
        permissions={"read"},
        agent_id="test-agent",
    )

    assert "sample.py" in str(search)
    assert "return helper()" in read.content
    assert "main -> helper" in str(inspection)


@pytest.mark.asyncio
async def test_tool_gateway_rejects_missing_permission(tmp_path: Path) -> None:
    """没有 write 权限的 Agent 不能调用工作区编辑工具。"""

    register_code_tools()
    context = ToolExecutionContext(
        agent_id="read-only",
        workspace_root=tmp_path,
        allowed_permissions=frozenset({"read"}),
    )

    with pytest.raises(PermissionError):
        await TOOL_GATEWAY.execute(
            ToolRequest("workspace.edit", {"operations": [object()]}),
            context=context,
        )


@pytest.mark.asyncio
async def test_sensitive_read_is_soft_filtered_without_retry_failure(tmp_path: Path) -> None:
    """敏感文件应在读取前过滤，安全文件仍正常返回且不会抛出工具错误。"""

    (tmp_path / "src").mkdir()
    (tmp_path / "src/app.ts").write_text("export const app = true;\n", "utf-8")
    (tmp_path / ".env.development").write_text("SECRET=never-return\n", "utf-8")
    (tmp_path / ".env.example").write_text("API_URL=\n", "utf-8")

    result = cast(
        ReadBatchResult,
        await execute_code_tool(
            "workspace.read",
            root=tmp_path,
            arguments={
                "paths": [".env.development", "src/app.ts", ".env.example"]
            },
            permissions={"read"},
            agent_id="test-agent",
        ),
    )

    assert result.blocked_paths == [".env.development"]
    assert "SECURITY SKIP" in result.content
    assert "never-return" not in result.content
    assert "export const app" in result.content
    assert "API_URL" in result.content


@pytest.mark.asyncio
async def test_write_alias_can_create_file_through_edit_tool(tmp_path: Path) -> None:
    """顶层 write 别名解析后应通过受控 edit 工具真实创建文件。"""

    from backend.services.agent.shared.loop_protocol import parse_agent_action

    action = parse_agent_action(
        '{"action":"write","workId":"W001","path":"src/created.ts",'
        '"content":"export const created = true;\\n"}'
    )
    result = await execute_code_tool(
        "workspace.edit",
        root=tmp_path,
        arguments={"operations": action.operations},
        permissions={"write"},
        agent_id="modify_worker:W001",
        task_id="W001",
    )

    assert "src/created.ts" in result.changed_files
    assert (tmp_path / "src/created.ts").read_text("utf-8") == (
        "export const created = true;\n"
    )
