"""Code Agent 工具目录。

本模块集中声明模型可使用的工作区工具，避免读代码、改代码和提示词优化阶段各自维护
一份容易漂移的工具列表。这里描述的是应用后端实际执行的受控工具，不依赖浏览器缓存。
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Literal

from backend.services.agent.shared.command_runner import command_approval_enabled

ToolScope = Literal["read", "write", "execute", "control"]
ExecutionMode = Literal["auto_edit", "full_auto"]


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
        description=(
            "读取一个或多个已知相对路径的文本文件；返回完整文件内容，"
            "超大文件可用 offsets 从指定字符位置分页查看。"
        ),
        example=(
            '{"action":"read","workId":"W001","paths":["src/app.ts"],'
            '"offsets":{"src/app.ts":12000}}'
        ),
    ),
    AgentToolDefinition(
        name="inspect",
        scope="read",
        description="使用 AST、符号索引、调用图和影响分析理解代码结构。",
        example='{"action":"inspect","workId":"W001","paths":["backend/main.py"],"query":"create_app"}',
    ),
    AgentToolDefinition(
        name="factory",
        scope="write",
        description=("规划、生成或校验电商领域模型、OpenAPI、Mock、API Client 和前端数据源。"),
        example=(
            '{"action":"factory","workId":"SF001","mode":"plan",'
            '"domainId":"commerce-miniapp","outputRoot":"src/features/commerce",'
            '"mockCount":12,"overwrite":false}'
        ),
    ),
    AgentToolDefinition(
        name="edit",
        scope="write",
        description=(
            "写入或新建文件的主工具；以 write、replace 或 delete 操作事务式修改项目文件。"
        ),
        example='{"action":"edit","workId":"W001","summary":"修复路由","operations":[{"type":"replace","path":"src/router.ts","oldText":"旧代码","newText":"新代码"}]}',
    ),
    AgentToolDefinition(
        name="run",
        scope="execute",
        description=(
            "运行受限的 test、lint、build、typecheck 等验证命令；"
            "安装/初始化类命令（pnpm install、pnpm add、npx create-vite 等）"
            "会先弹出用户审批，确认后才执行。"
        ),
        example='{"action":"run","workId":"W001","command":"pnpm typecheck"}',
    ),
    AgentToolDefinition(
        name="run_code",
        scope="execute",
        description=(
            "写一段 Python 程序批量调用 read/edit/run/search 工具（tools 对象），"
            "一次完成多个文件操作，只有 print/return 会回到上下文。需 CODE_AGENT_CODE_MODE=1 且全自动模式。"
        ),
        example='{"action":"run_code","workId":"W001","code":"content = await tools.read(\'src/app.ts\'); print(content)"}',
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
    AgentToolDefinition(
        name="browser_navigate",
        scope="control",
        description=(
            "在内置浏览器中打开网页（localhost 预览或任意 http/https 页面），"
            "返回标题与正文文本预览。首次使用会请求用户审批。"
        ),
        example=(
            '{"action":"browser_navigate","workId":"W001","tool":"navigate",'
            '"arguments":{"url":"http://127.0.0.1:5173"}}'
        ),
    ),
    AgentToolDefinition(
        name="browser_extract",
        scope="control",
        description="抽取内置浏览器当前页面或指定 CSS 元素的可见文本。",
        example='{"action":"browser_extract","workId":"W001","tool":"extract","arguments":{}}',
    ),
    AgentToolDefinition(
        name="browser_click",
        scope="control",
        description=("点击内置浏览器页面元素：优先 CSS 选择器，也可用可见文本匹配按钮/链接。"),
        example=(
            '{"action":"browser_click","workId":"W001","tool":"click",'
            '"arguments":{"text":"登录"}}'
        ),
    ),
    AgentToolDefinition(
        name="browser_fill",
        scope="control",
        description="向内置浏览器页面的输入框写入文本（兼容 React 受控组件）。",
        example=(
            '{"action":"browser_fill","workId":"W001","tool":"fill",'
            '"arguments":{"selector":"#username","value":"demo"}}'
        ),
    ),
    AgentToolDefinition(
        name="browser_screenshot",
        scope="control",
        description="截取内置浏览器当前页面，返回降采样 JPEG（base64）与尺寸信息。",
        example='{"action":"browser_screenshot","workId":"W001","tool":"screenshot","arguments":{}}',
    ),
    AgentToolDefinition(
        name="browser_look",
        scope="control",
        description=(
            "截图当前页面并交给视觉模型观察，返回页面状态的文字结论——"
            "操作后看一眼页面再决定下一步。需要已配置支持视觉的模型。"
        ),
        example=(
            '{"action":"browser_look","workId":"W001","tool":"look",'
            '"arguments":{"goal":"确认登录表单是否已填写完整"}}'
        ),
    ),
)


READ_ONLY_TOOL_NAMES = ("search", "read", "inspect", "finish")
AUTO_EDIT_TOOL_NAMES = (
    "search",
    "read",
    "inspect",
    "factory",
    "edit",
    "complete_work",
    "finish",
)
FULL_AUTO_TOOL_NAMES = (*AUTO_EDIT_TOOL_NAMES[:-2], "run", *AUTO_EDIT_TOOL_NAMES[-2:])


def browser_tools_enabled() -> bool:
    """浏览器自动化工具开关（默认开，BROWSER_TOOLS_ENABLED=0 关闭）。"""

    return os.getenv("BROWSER_TOOLS_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"}


BROWSER_TOOL_NAMES = (
    "browser_navigate",
    "browser_extract",
    "browser_click",
    "browser_fill",
    "browser_screenshot",
    "browser_look",
)


def code_mode_enabled() -> bool:
    """run_code 批量执行通道开关（默认关闭，CODE_AGENT_CODE_MODE=1 启用）。"""

    return os.getenv("CODE_AGENT_CODE_MODE", "").strip() == "1"


def tool_names_for_mode(
    *,
    read_only: bool = False,
    execution_mode: ExecutionMode = "full_auto",
) -> tuple[str, ...]:
    """返回当前运行分支真实允许模型选择的内部动作名称。"""

    if read_only:
        return READ_ONLY_TOOL_NAMES
    names = FULL_AUTO_TOOL_NAMES if execution_mode == "full_auto" else AUTO_EDIT_TOOL_NAMES
    # run_code 批量执行通道：仅显式开启且全自动模式才暴露（可回滚）。
    if code_mode_enabled() and execution_mode == "full_auto" and "run_code" not in names:
        names = (*names, "run_code")
    # 命令审批门开启时，自动编辑模式也暴露 run（只有安装/初始化类命令会弹审批，
    # 其余命令仍由 _run 按“自动编辑模式”跳过，不执行终端命令）。
    if command_approval_enabled() and execution_mode == "auto_edit" and "run" not in names:
        names = (*names, "run")
    # 浏览器自动化工具：仅全自动模式暴露（动作有真实页面副作用，且首次使用需审批）。
    if browser_tools_enabled() and execution_mode == "full_auto":
        names = (*names, *(name for name in BROWSER_TOOL_NAMES if name not in names))
    return names


def render_tool_catalog(
    *,
    read_only: bool = False,
    compact: bool = False,
    execution_mode: ExecutionMode = "full_auto",
) -> str:
    """把当前模式的真实工具目录渲染为模型可读文本。"""

    allowed = set(tool_names_for_mode(read_only=read_only, execution_mode=execution_mode))
    lines: list[str] = []
    for tool in CODE_AGENT_TOOLS:
        if tool.name not in allowed:
            continue
        if compact:
            lines.append(f"- {tool.name}：{tool.description}")
        else:
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


def build_openai_tools(
    *,
    execution_mode: ExecutionMode = "full_auto",
) -> list[dict[str, Any]]:
    """把当前模式的工具目录转换为 OpenAI Function Calling Schema。

    每个工具对应一个 OpenAI 兼容 ``function`` 定义。模型收到这些 tools 后
    会直接返回结构化的 ``tool_calls``，不再输出大段自然语言分析再给 JSON，
    与 ZCode/Claude Code 的“架构级工具约束”对齐。
    """

    from backend.services.agent.shared.loop_protocol import (
        EditOperationModel,
    )

    allowed = set(tool_names_for_mode(read_only=False, execution_mode=execution_mode))
    # 每类动作的参数 Schema；关键字段保持与文本协议一致（parse_agent_action 兼容）。
    schemas: dict[str, dict[str, Any]] = {
        "search": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "const": "search"},
                "workId": {"type": "string", "description": "当前 Work ID"},
                "query": {"type": "string", "description": "搜索关键词"},
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "限定搜索范围的文件路径",
                },
            },
            "required": ["action", "query"],
        },
        "read": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "const": "read"},
                "workId": {"type": "string"},
                "paths": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "要读取的相对路径",
                },
                "offsets": {
                    "type": "object",
                    "description": "超大文件分页：path -> 字符偏移",
                    "additionalProperties": {"type": "integer"},
                },
            },
            "required": ["action", "paths"],
        },
        "inspect": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "const": "inspect"},
                "workId": {"type": "string"},
                "paths": {"type": "array", "items": {"type": "string"}},
                "query": {"type": "string"},
            },
            "required": ["action", "paths"],
        },
        "edit": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "const": "edit"},
                "workId": {"type": "string"},
                "summary": {"type": "string"},
                "operations": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": EditOperationModel.model_json_schema().get("properties", {}),
                    },
                    "description": "write 新建完整文件；replace 只给最小定位片段（3~8 行），禁止整段重写",
                },
            },
            "required": ["action", "operations"],
        },
        "run": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "const": "run"},
                "workId": {"type": "string"},
                "command": {"type": "string"},
            },
            "required": ["action", "command"],
        },
        "run_code": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "const": "run_code"},
                "workId": {"type": "string"},
                "code": {
                    "type": "string",
                    "description": "一段 Python 程序，通过 tools 对象批量调用 read/edit/run/search；只有 print/return 会回到上下文",
                },
                "description": {
                    "type": "string",
                    "description": "这段程序要完成什么（简要）",
                },
            },
            "required": ["action", "code"],
        },
        "complete_work": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "const": "complete_work"},
                "workId": {"type": "string"},
                "summary": {"type": "string"},
            },
            "required": ["action", "workId", "summary"],
        },
        "finish": {
            "type": "object",
            "properties": {
                "action": {"type": "string", "const": "finish"},
                "summary": {"type": "string"},
            },
            "required": ["action", "summary"],
        },
    }
    # 浏览器自动化：动作统一走 "browser"，tool 字段区分子动作；openai 工具名
    # 与 CODE_AGENT_TOOLS 的 browser_* 一一对应，arguments 结构随动作不同。
    browser_argument_schemas: dict[str, dict[str, Any]] = {
        "navigate": {
            "url": {"type": "string", "description": "要打开的 http/https 地址"},
        },
        "extract": {
            "selector": {
                "type": "string",
                "description": "可选 CSS 选择器；缺省时返回整页可见文本",
            },
        },
        "click": {
            "selector": {"type": "string", "description": "可选 CSS 选择器"},
            "text": {"type": "string", "description": "可选可见文本匹配（按钮/链接）"},
        },
        "fill": {
            "selector": {"type": "string", "description": "输入框 CSS 选择器"},
            "value": {"type": "string", "description": "要写入的文本"},
        },
        "screenshot": {},
        "look": {
            "goal": {"type": "string", "description": "观察目标（想让视觉模型确认什么）"},
        },
    }
    for browser_tool, argument_schema in browser_argument_schemas.items():
        schemas[f"browser_{browser_tool}"] = {
            "type": "object",
            "properties": {
                "action": {"type": "string", "const": "browser"},
                "workId": {"type": "string"},
                "tool": {"type": "string", "const": browser_tool},
                "arguments": {
                    "type": "object",
                    "properties": argument_schema,
                    **(
                        {"required": list(argument_schema)}
                        if browser_tool in {"navigate", "fill"}
                        else {}
                    ),
                },
            },
            "required": ["action", "tool", "arguments"],
        }
    tools: list[dict[str, Any]] = []
    for tool in CODE_AGENT_TOOLS:
        if tool.name not in allowed or tool.name not in schemas:
            continue
        tools.append(
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": schemas[tool.name],
                },
            }
        )
    return tools
