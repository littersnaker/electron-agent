"""Code Agent 多轮工具协议解析与约束。

模型每一轮只能选择一个工具动作。后端执行动作后把真实结果返回给下一轮，
从而避免旧版“一次生成全部文件”的脆弱工作方式。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Literal

from backend.services.agent.domain_rules import default_factory_domain_id


ActionKind = Literal[
    "search",
    "read",
    "inspect",
    "factory",
    "edit",
    "run",
    "complete_work",
    "finish",
]
OperationKind = Literal["write", "replace", "delete"]
MAX_BATCH_TEXT_CHARS = 2_500_000


@dataclass(slots=True)
class EditOperation:
    """单个工作区编辑操作。"""

    type: OperationKind
    path: str
    content: str = ""
    old_text: str = ""
    new_text: str = ""
    replace_all: bool = False
    reason: str = "按任务要求修改"


@dataclass(slots=True)
class AgentAction:
    """模型在一轮代理循环中选择的工具动作。"""

    action: ActionKind
    work_id: str = ""
    query: str = ""
    paths: list[str] = field(default_factory=list)
    offsets: dict[str, int] = field(default_factory=dict)
    operations: list[EditOperation] = field(default_factory=list)
    command: str = ""
    factory_mode: str = ""
    factory_domain_id: str = field(default_factory=default_factory_domain_id)
    factory_output_root: str = ""
    factory_mock_count: int = 12
    factory_overwrite: bool = False
    summary: str = ""
    tests: list[str] = field(default_factory=list)


def _extract_json(text: str) -> dict[str, Any]:
    """从模型回复中提取首个平衡 JSON 对象，并兼容常见尾逗号。"""

    stripped = text.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", stripped, re.IGNORECASE)
    candidate = fenced.group(1).strip() if fenced else stripped
    fragment = _first_balanced_object(candidate)
    try:
        value = json.loads(fragment)
    except json.JSONDecodeError:
        # 部分兼容模型会在对象或数组结尾留下尾逗号；只修复结构分隔符，
        # 不尝试猜测缺失字段，避免把自然语言误当成可执行动作。
        repaired = re.sub(r",\s*([}\]])", r"\1", fragment)
        try:
            value = json.loads(repaired)
        except json.JSONDecodeError as exc:
            raise ValueError(f"代理工具 JSON 无效：{exc.msg}") from exc
    if not isinstance(value, dict):
        raise ValueError("代理工具响应必须是 JSON 对象")
    return _normalize_tool_wrapper(value)


def _first_balanced_object(text: str) -> str:
    """按字符串和转义规则寻找首个完整对象，避免多个示例 JSON 相互污染。"""

    start = text.find("{")
    if start < 0:
        raise ValueError("模型没有返回代理工具 JSON")
    depth = 0
    in_string = False
    escaped = False
    for index in range(start, len(text)):
        character = text[index]
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
        elif character == "{":
            depth += 1
        elif character == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
    raise ValueError("模型返回的代理工具 JSON 未闭合")


def _normalize_tool_wrapper(value: dict[str, Any]) -> dict[str, Any]:
    """把 OpenAI 风格 tool-call 包装转换为内部单动作协议。"""

    if value.get("action"):
        action = str(value["action"]).strip().lower()
        normalized_action = _normalize_action_name(action)
        value["action"] = normalized_action
        if normalized_action == "edit" and not value.get("operations"):
            simple_operation = _simple_write_operation(value)
            if simple_operation:
                value["operations"] = [simple_operation]
        return value

    function = value.get("function")
    name = value.get("name") or value.get("tool")
    arguments = value.get("arguments")
    if isinstance(function, dict):
        name = function.get("name") or name
        arguments = function.get("arguments") or arguments
    if not name:
        return value
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError:
            arguments = {}
    normalized = dict(arguments) if isinstance(arguments, dict) else {}
    normalized_name = str(name).strip().lower()
    normalized["action"] = _normalize_action_name(normalized_name)
    if normalized_name.startswith("software_factory.") and not normalized.get("mode"):
        normalized["mode"] = normalized_name.rsplit(".", 1)[-1]
    return normalized


def _normalize_action_name(value: str) -> str:
    """兼容供应商常见的工具全名和完成动作别名。"""

    aliases = {
        "workspace.search": "search",
        "workspace.read": "read",
        "code.inspect": "inspect",
        "workspace.edit": "edit",
        "workspace.write": "edit",
        "write": "edit",
        "create_file": "edit",
        "workspace.run": "run",
        "software_factory.plan": "factory",
        "software_factory.generate": "factory",
        "software_factory.validate": "factory",
        "complete": "complete_work",
        "done": "complete_work",
    }
    return aliases.get(value, value.rsplit(".", 1)[-1])


def _simple_write_operation(value: dict[str, Any]) -> dict[str, Any] | None:
    """把供应商常见的顶层 write/path/content 结构转换为 edit 操作。"""

    path = str(value.get("path") or "").strip()
    content = value.get("content")
    if not path or not isinstance(content, str):
        return None
    return {
        "type": "write",
        "path": path,
        "content": content,
        "reason": str(value.get("reason") or value.get("summary") or "按任务要求写入文件"),
    }


def _clean_path(value: object) -> str:
    """清洗模型返回的工作区相对路径。"""

    return str(value or "").strip().replace("\\", "/")


def coerce_read_paths(value: object) -> list[str]:
    """把模型常见的 paths 变体归一化为去重后的相对路径数组。

    兼容：paths 数组、path 单数字段、逗号/中文逗号/换行分隔的字符串。
    返回空数组表示模型没有给出任何可用路径。
    """

    raw: list[object] = []
    if isinstance(value, str):
        raw = [
            part.strip()
            for part in re.split(r"[,，\n]+", value)
            if part.strip()
        ]
    elif isinstance(value, list):
        raw = value
    return list(dict.fromkeys(_clean_path(item) for item in raw if _clean_path(item)))


def _pick_paths(raw: dict[str, Any]) -> object:
    """兼容模型对路径字段的常见命名：paths / path / targetFiles / files。"""

    for key in ("paths", "path", "targetFiles", "target_files", "files"):
        if key in raw:
            return raw[key]
    return None


def _parse_operations(raw: object) -> list[EditOperation]:
    """解析并校验一批编辑操作。"""

    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        raise ValueError("edit 动作 operations 必须是数组")
    if not raw:
        # 空 operations 表示“目标已满足，无需修改”，由调用方决定语义，
        # 不再作为硬性协议错误（批量直写提示词明确允许这种表达）。
        return []
    operations: list[EditOperation] = []
    payload_size = 0
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("编辑操作必须是 JSON 对象")
        operation_type = str(item.get("type") or "").strip().lower()
        if operation_type not in {"write", "replace", "delete"}:
            raise ValueError(f"不支持的编辑操作：{operation_type or '空'}")
        path = _clean_path(item.get("path"))
        if not path:
            raise ValueError("编辑操作缺少 path")

        content = str(item.get("content") or "")
        old_text = str(item.get("oldText") or item.get("old_text") or "")
        new_text = str(item.get("newText") or item.get("new_text") or "")
        if operation_type == "write":
            content_value = item.get("content")
            if not isinstance(content_value, str) or not content_value.strip():
                raise ValueError(
                    f"write 操作必须包含非空 content（禁止空文件/占位）：{path}"
                )
        if operation_type == "replace" and not old_text:
            raise ValueError(f"replace 操作缺少 oldText：{path}")

        payload_size += len(content) + len(old_text) + len(new_text)
        operations.append(
            EditOperation(
                type=operation_type,  # type: ignore[arg-type]
                path=path,
                content=content,
                old_text=old_text,
                new_text=new_text,
                replace_all=bool(item.get("replaceAll") or item.get("replace_all")),
                reason=str(item.get("reason") or "按任务要求修改")[:500],
            )
        )

    if payload_size > MAX_BATCH_TEXT_CHARS:
        raise ValueError("单轮编辑内容过大，请拆成多个 edit 动作")
    return operations


def parse_agent_action(text: str) -> AgentAction:
    """把模型输出解析成严格的单动作协议。"""

    raw = _extract_json(text)
    action = str(raw.get("action") or "").strip().lower()
    if action not in {
        "search",
        "read",
        "inspect",
        "factory",
        "edit",
        "run",
        "complete_work",
        "finish",
    }:
        raise ValueError(f"未知代理动作：{action or '空'}")

    work_id = str(raw.get("workId") or raw.get("work_id") or "").strip().upper()[:40]

    if action == "search":
        query = str(raw.get("query") or "").strip()
        if not query:
            raise ValueError("search 动作缺少 query")
        return AgentAction(action="search", work_id=work_id, query=query[:1000])

    if action == "read":
        paths = coerce_read_paths(_pick_paths(raw))
        if not paths:
            raise ValueError("read 动作必须包含 paths（非空相对路径数组）")
        offsets: dict[str, int] = {}
        raw_offsets = raw.get("offsets")
        if isinstance(raw_offsets, dict):
            for raw_path, value in raw_offsets.items():
                path = _clean_path(raw_path)
                if not path:
                    continue
                try:
                    offset = max(0, int(value))
                except (TypeError, ValueError):
                    continue
                if offset > 0:
                    offsets[path] = offset
        return AgentAction(action="read", work_id=work_id, paths=paths, offsets=offsets)

    if action == "inspect":
        paths = coerce_read_paths(_pick_paths(raw))
        query = str(raw.get("query") or "").strip()[:1000]
        if not paths and not query:
            raise ValueError("inspect 动作必须包含 paths 或 query")
        return AgentAction(action="inspect", work_id=work_id, paths=paths, query=query)

    if action == "factory":
        mode = str(raw.get("mode") or "").strip().lower()
        if mode not in {"plan", "generate", "validate"}:
            raise ValueError("factory 动作 mode 必须是 plan、generate 或 validate")
        output_root = _clean_path(raw.get("outputRoot") or raw.get("output_root"))
        if mode == "validate" and not output_root:
            raise ValueError("factory validate 必须包含 outputRoot")
        try:
            mock_count = int(raw.get("mockCount") or raw.get("mock_count") or 12)
        except (TypeError, ValueError):
            mock_count = 12
        return AgentAction(
            action="factory",
            work_id=work_id,
            factory_mode=mode,
            factory_domain_id=str(
                raw.get("domainId")
                or raw.get("domain_id")
                or default_factory_domain_id()
            ).strip()[:100],
            factory_output_root=output_root[:1000],
            factory_mock_count=max(3, min(mock_count, 100)),
            factory_overwrite=bool(raw.get("overwrite")),
            summary=str(raw.get("summary") or "执行 Software Factory")[:2000],
        )

    if action == "edit":
        return AgentAction(
            action="edit",
            work_id=work_id,
            operations=_parse_operations(raw.get("operations")),
            summary=str(raw.get("summary") or "执行一批代码修改")[:2000],
        )

    if action == "run":
        command = str(raw.get("command") or "").strip()
        if not command:
            raise ValueError("run 动作缺少 command")
        return AgentAction(action="run", work_id=work_id, command=command[:2000])

    if action == "complete_work":
        if not work_id:
            raise ValueError("complete_work 动作缺少 workId")
        return AgentAction(
            action="complete_work",
            work_id=work_id,
            summary=str(raw.get("summary") or "工作项已完成")[:4000],
        )

    raw_tests = raw.get("tests")
    tests = [str(item)[:500] for item in raw_tests] if isinstance(raw_tests, list) else []
    return AgentAction(
        action="finish",
        summary=str(raw.get("summary") or "任务已完成")[:8000],
        tests=tests[:30],
    )
