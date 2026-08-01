"""Code Agent 工具目录。

本模块集中声明模型可使用的工作区工具，避免读代码、改代码和提示词优化阶段各自维护
一份容易漂移的工具列表。这里描述的是应用后端实际执行的受控工具，不依赖浏览器缓存。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

ToolScope = Literal["read", "write", "execute", "control"]


@dataclass(frozen=True, slots=True)
class AgentToolDefinition:
    """描述一个 Code Agent 工具及其使用边界。"""

    name: str
    scope: ToolScope
    description: str
    example: str


CODE_AGENT_TOOLS: tuple[AgentToolDefinition, ...] = (
    AgentToolDefinition(
        name="search",
        scope="read",
        description="按文件名、符号名或关键词搜索当前项目；搜索直接读取磁盘，不依赖索引命中。",
        example='{"action":"search","workId":"W001","query":"购物车 order payment"}',
    ),
    AgentToolDefinition(
        name="read",
        scope="read",
        description="读取一个或多个已知相对路径的文本文件；内容过大时可在下一轮继续读取。",
        example='{"action":"read","workId":"W001","paths":["package.json","src/app.ts"]}',
    ),
    AgentToolDefinition(
        name="edit",
        scope="write",
        description="以 write、replace 或 delete 操作事务式修改项目文件。",
        example='{"action":"edit","workId":"W001","summary":"修复路由","operations":[{"type":"replace","path":"src/router.ts","oldText":"旧代码","newText":"新代码"}]}',
    ),
    AgentToolDefinition(
        name="run",
        scope="execute",
        description="在全自动模式运行受限的 test、lint、build、typecheck 等验证命令。",
        example='{"action":"run","workId":"W001","command":"pnpm typecheck"}',
    ),
    AgentToolDefinition(
        name="complete_work",
        scope="control",
        description="确认一个 Work 的真实产物和验收结果，成功后不会在重规划中重复执行。",
        example='{"action":"complete_work","workId":"W001","summary":"已完成并通过验证"}',
    ),
    AgentToolDefinition(
        name="finish",
        scope="control",
        description="全部 Work 成功或明确跳过后生成最终交付摘要。",
        example='{"action":"finish","summary":"任务完成","tests":[]}',
    ),
)


READ_ONLY_TOOL_NAMES = ("search", "read", "finish")


def render_tool_catalog(*, read_only: bool = False) -> str:
    """把工具目录渲染为模型可读的稳定文本。"""

    allowed = set(READ_ONLY_TOOL_NAMES) if read_only else None
    lines: list[str] = []
    for tool in CODE_AGENT_TOOLS:
        if allowed is not None and tool.name not in allowed:
            continue
        lines.append(
            f"- {tool.name} [{tool.scope}]：{tool.description}\n  示例：{tool.example}"
        )
    return "\n".join(lines)


def public_tool_catalog() -> list[dict[str, str]]:
    """返回可用于诊断页面或测试的非敏感工具目录。"""

    return [
        {
            "name": tool.name,
            "scope": tool.scope,
            "description": tool.description,
        }
        for tool in CODE_AGENT_TOOLS
    ]
