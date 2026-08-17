"""Code Agent 多轮工具协议解析与约束。

模型每一轮只能选择一个工具动作。后端执行动作后把真实结果返回给下一轮，
从而避免旧版“一次生成全部文件”的脆弱工作方式。

解析层使用 Pydantic Schema（EditOperationModel / ActionRequestModel）做字段
映射与校验：AliasChoices 集中管理各家模型的字段命名差异，validators 负责
值归一化（动作别名、路径清洗、布尔/数字/文本转换）。模型外层仍保留宽容的
JSON 提取与 tool-call 包装归一化，作为不支持原生工具调用模型的兜底。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Literal

from pydantic import (
    AliasChoices,
    BaseModel,
    ConfigDict,
    Field,
    field_validator,
    model_validator,
)

from backend.services.agent.shared.domain_rules import default_factory_domain_id

ActionKind = Literal[
    "search",
    "read",
    "inspect",
    "factory",
    "edit",
    "run",
    "run_code",
    "mcp",
    "complete_work",
    "finish",
]
OperationKind = Literal["write", "replace", "delete"]
MAX_BATCH_TEXT_CHARS = 2_500_000

# 模型工具调用风格的常见包装键：既有 OpenAI arguments，也有 payload/param/input 等。
_WRAPPER_KEYS = (
    "payload",
    "data",
    "params",
    "param",
    "input",
    "parameters",
    "arguments",
)

_ACTION_KEYS = frozenset(
    {
        "search",
        "read",
        "inspect",
        "factory",
        "edit",
        "run",
        "run_code",
        "mcp",
        "complete_work",
        "finish",
    }
)

_OPERATION_TYPE_ALIASES = {
    "write": "write",
    "create": "write",
    "create_file": "write",
    "new_file": "write",
    "replace": "replace",
    "edit": "replace",
    "update": "replace",
    "patch": "replace",
    "delete": "delete",
    "remove": "delete",
    "unlink": "delete",
}
_OPERATION_PATH_KEYS = ("path", "file", "filePath", "file_path", "target", "targetPath", "target_path")
_OPERATION_CONTENT_KEYS = ("content", "data", "text", "body")
_OPERATION_OLD_KEYS = (
    "old",
    "oldText",
    "old_text",
    "search",
    "searchText",
    "match",
    "from",
    "oldValue",
    "old_value",
)
_OPERATION_NEW_KEYS = (
    "new",
    "newText",
    "new_text",
    "replace",
    "replacement",
    "to",
    "value",
    "newValue",
    "new_value",
)
_OPERATION_REASON_KEYS = ("reason", "why", "comment")


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
    code: str = ""
    tool: str = ""
    arguments: dict[str, Any] = field(default_factory=dict)
    factory_mode: str = ""
    factory_domain_id: str = field(default_factory=default_factory_domain_id)
    factory_output_root: str = ""
    factory_mock_count: int = 12
    factory_overwrite: bool = False
    summary: str = ""
    tests: list[str] = field(default_factory=list)


class EditOperationModel(BaseModel):
    """Pydantic 编辑操作 Schema：一个定义同时用于字段映射与运行时校验。"""

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    type: OperationKind = Field(
        validation_alias=AliasChoices("type", "op", "operation", "action")
    )
    path: str = Field(validation_alias=AliasChoices(*_OPERATION_PATH_KEYS))
    content: str = Field(
        "",
        validation_alias=AliasChoices(*_OPERATION_CONTENT_KEYS),
    )
    old_text: str = Field(
        "",
        validation_alias=AliasChoices(*_OPERATION_OLD_KEYS),
    )
    new_text: str = Field(
        "",
        validation_alias=AliasChoices(*_OPERATION_NEW_KEYS),
    )
    replace_all: bool = Field(
        False,
        validation_alias=AliasChoices("replaceAll", "replace_all", "all", "global"),
    )
    reason: str = Field(
        "按任务要求修改",
        validation_alias=AliasChoices(*_OPERATION_REASON_KEYS),
    )

    @field_validator("type", mode="before")
    @classmethod
    def _normalize_operation_type(cls, value: object) -> object:
        """把 create/edit/update/patch 等操作名映射到内部 write/replace/delete。"""

        if value is None:
            raise ValueError("不支持的编辑操作：空")
        operation_type = _OPERATION_TYPE_ALIASES.get(str(value).strip().lower())
        if operation_type is None:
            raise ValueError(f"不支持的编辑操作：{value}")
        return operation_type

    @field_validator("path", mode="before")
    @classmethod
    def _normalize_operation_path(cls, value: object) -> str:
        return _clean_path(value)

    @field_validator("content", "old_text", "new_text", "reason", mode="before")
    @classmethod
    def _coerce_operation_text(cls, value: object) -> str:
        return value if isinstance(value, str) else (str(value) if value is not None else "")

    @model_validator(mode="after")
    def _finalize_operation(self) -> EditOperationModel:
        """执行依赖字段之间的协议约束。"""

        if not self.reason:
            self.reason = "按任务要求修改"
        self.reason = self.reason[:500]
        if not self.path:
            raise ValueError("编辑操作缺少 path")
        if self.type == "write" and not self.content.strip():
            raise ValueError(
                f"write 操作必须包含非空 content（禁止空文件/占位）：{self.path}"
            )
        if self.type == "replace" and not self.old_text:
            raise ValueError(f"replace 操作缺少 oldText：{self.path}")
        return self

    def to_domain(self) -> EditOperation:
        """转换为内部 EditOperation 值对象。"""

        return EditOperation(
            type=self.type,
            path=self.path,
            content=self.content,
            old_text=self.old_text,
            new_text=self.new_text,
            replace_all=self.replace_all,
            reason=self.reason,
        )


class ActionRequestModel(BaseModel):
    """模型单轮动作请求的 Pydantic Schema。

    字段别名集中在这里：workId/work_id、paths/path/files、outputRoot/output_root、
    mockCount/mock_count、domainId/domain_id、operations/ops 等。
    """

    model_config = ConfigDict(populate_by_name=True, extra="ignore")

    action: str
    work_id: str = Field(
        "",
        validation_alias=AliasChoices("work_id", "workId", "workid", "WorkId"),
    )
    query: str = ""
    paths: list[str] = Field(
        default_factory=list,
        validation_alias=AliasChoices(
            "paths",
            "path",
            "file",
            "files",
            "targets",
            "filePaths",
            "file_paths",
            "targetFiles",
            "target_files",
            "readPaths",
            "read_paths",
        ),
    )
    offsets: dict[str, int] = Field(default_factory=dict)
    operations: list[EditOperationModel] | None = Field(
        default=None,
        validation_alias=AliasChoices("operations", "ops"),
    )
    command: str = ""
    code: str = ""
    tool: str = Field(
        "",
        validation_alias=AliasChoices("tool", "toolName", "tool_name", "name"),
    )
    arguments: dict[str, Any] = Field(
        default_factory=dict,
        validation_alias=AliasChoices("arguments", "args", "params", "parameters"),
    )
    mode: str = ""
    output_root: str = Field(
        "",
        validation_alias=AliasChoices("outputRoot", "output_root"),
    )
    mock_count: int = Field(
        12,
        validation_alias=AliasChoices("mockCount", "mock_count"),
    )
    overwrite: bool = False
    domain_id: str = Field(
        "",
        validation_alias=AliasChoices("domainId", "domain_id"),
    )
    summary: str = ""
    tests: list[str] = Field(default_factory=list)

    @model_validator(mode="before")
    @classmethod
    def _merge_work_id_aliases(cls, data: object) -> object:
        """按旧协议优先级合并 workId/workid/WorkId，避免空值抢占有效值。"""

        if not isinstance(data, dict):
            return data
        work_id = (
            data.get("work_id")
            or data.get("workId")
            or data.get("workid")
            or data.get("WorkId")
            or ""
        )
        if work_id:
            return {**data, "work_id": work_id}
        return data

    @field_validator("action", mode="before")
    @classmethod
    def _normalize_action(cls, value: object) -> str:
        return _normalize_action_name(str(value or "").strip().lower())

    @field_validator("work_id", mode="before")
    @classmethod
    def _coerce_work_id(cls, value: object) -> str:
        return str(value or "").strip().upper()[:40]

    @field_validator("query", "command", "summary", mode="before")
    @classmethod
    def _coerce_string(cls, value: object) -> str:
        return str(value or "").strip()

    @field_validator("mode", mode="before")
    @classmethod
    def _coerce_mode(cls, value: object) -> str:
        return str(value or "").strip().lower()

    @field_validator("paths", mode="before")
    @classmethod
    def _coerce_paths(cls, value: object) -> list[str]:
        return coerce_read_paths(value)

    @field_validator("offsets", mode="before")
    @classmethod
    def _coerce_offsets(cls, value: object) -> dict[str, int]:
        if not isinstance(value, dict):
            return {}
        offsets: dict[str, int] = {}
        for raw_path, raw_offset in value.items():
            path = _clean_path(raw_path)
            if not path:
                continue
            try:
                offset = max(0, int(raw_offset))
            except (TypeError, ValueError):
                continue
            if offset > 0:
                offsets[path] = offset
        return offsets

    @field_validator("operations", mode="before")
    @classmethod
    def _coerce_operations(cls, value: object) -> object:
        if isinstance(value, dict):
            return [value]
        if value is None:
            return None
        if not isinstance(value, list):
            raise ValueError("edit 动作 operations 必须是数组")
        return value

    @field_validator("output_root", mode="before")
    @classmethod
    def _coerce_output_root(cls, value: object) -> str:
        return _clean_path(value)[:1000]

    @field_validator("mock_count", mode="before")
    @classmethod
    def _coerce_mock_count(cls, value: object) -> int:
        try:
            count = int(value)
        except (TypeError, ValueError):
            return 12
        return max(3, min(count, 100))

    @field_validator("overwrite", mode="before")
    @classmethod
    def _coerce_overwrite(cls, value: object) -> object:
        if isinstance(value, str):
            return value.strip().lower() in {"1", "true", "yes", "on"}
        return value

    @field_validator("domain_id", mode="before")
    @classmethod
    def _coerce_domain_id(cls, value: object) -> str:
        return str(value or "")[:100]

    @field_validator("tests", mode="before")
    @classmethod
    def _coerce_tests(cls, value: object) -> list[str]:
        if not isinstance(value, list):
            return []
        return [str(item)[:500] for item in value]

    @model_validator(mode="after")
    def _validate_action(self) -> ActionRequestModel:
        """执行动作级别协议约束。"""

        action = self.action
        if action not in {
            "search",
            "read",
            "inspect",
            "factory",
            "edit",
            "run",
            "run_code",
            "mcp",
            "complete_work",
            "finish",
        }:
            raise ValueError(f"未知代理动作：{action or '空'}")
        if action == "search" and not self.query:
            raise ValueError("search 动作缺少 query")
        if action == "read" and not self.paths:
            raise ValueError("read 动作必须包含 paths（非空相对路径数组）")
        if action == "inspect" and not self.paths and not self.query:
            raise ValueError("inspect 动作必须包含 paths 或 query")
        if action == "factory":
            if self.mode not in {"plan", "generate", "validate", "manifest"}:
                raise ValueError(
                    "factory 动作 mode 必须是 plan、generate、validate 或 manifest"
                )
            if self.mode == "validate" and not self.output_root:
                raise ValueError("factory validate 必须包含 outputRoot")
        if action == "edit":
            if self.operations is None:
                raise ValueError("edit 动作 operations 必须是数组")
            _check_batch_size(self.operations)
        if action == "run" and not self.command:
            raise ValueError("run 动作缺少 command")
        if action == "run_code" and not self.code:
            raise ValueError("run_code 动作缺少 code")
        if action == "mcp" and not self.tool:
            raise ValueError("mcp 动作缺少 tool（例如 mcp__server__tool）")
        if action == "complete_work" and not self.work_id:
            raise ValueError("complete_work 动作缺少 workId")
        return self


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


def _lift_wrapped_fields(value: dict[str, Any]) -> dict[str, Any]:
    """把 payload/data/param/input/parameters 等包装里的常用字段提升到顶层。"""

    for wrapper_key in _WRAPPER_KEYS:
        wrapper = value.get(wrapper_key)
        if not isinstance(wrapper, dict):
            continue
        for field_name in (
            "operations",
            "paths",
            "path",
            "file",
            "files",
            "targets",
            "query",
            "command",
            "content",
            "offsets",
            "summary",
            "mode",
            "outputRoot",
            "output_root",
            "workId",
            "work_id",
        ):
            if field_name not in value and field_name in wrapper:
                value[field_name] = wrapper[field_name]
    return value


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

    value = _unwrap_action_key(value)
    if value.get("action"):
        value = _lift_wrapped_fields(value)
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
    if not normalized:
        # 兼容 tool + payload/param/input/parameters 的嵌套参数（无 arguments 包装）。
        for wrapper_key in _WRAPPER_KEYS:
            nested = value.get(wrapper_key)
            if isinstance(nested, dict):
                normalized = dict(nested)
                break
    # 顶层字段（workId/summary/paths 等）必须保留，不能因为缺少 arguments 被丢弃。
    for key, item in value.items():
        if key in {"tool", "function", "name", "type", "id", *_WRAPPER_KEYS}:
            continue
        if key not in normalized:
            normalized[key] = item
    normalized_name = str(name).strip().lower()
    normalized["action"] = _normalize_action_name(normalized_name)
    if normalized_name.startswith("software_factory.") and not normalized.get("mode"):
        normalized["mode"] = normalized_name.rsplit(".", 1)[-1]
    if normalized["action"] == "edit" and not normalized.get("operations"):
        simple_operation = _simple_write_operation(normalized)
        if simple_operation:
            normalized["operations"] = [simple_operation]
    return normalized


def _unwrap_action_key(value: dict[str, Any]) -> dict[str, Any]:
    """把模型常见的"动作名作为根键"包装转换为内部单动作协议。

    例如 {"read": ["a.ts"]}、{"read": {"paths": ["a.ts"]}}、{"search": "cart"}、
    {"complete_work": {"workId": "W001", "summary": "..."}} 等。
    """

    if not isinstance(value, dict):
        return value
    if any(key in value for key in ("action", "tool", "function", "name")):
        return value
    keys = [key for key in value if isinstance(key, str)]
    if len(keys) != 1:
        return value
    action = _normalize_action_name(keys[0])
    if action not in _ACTION_KEYS:
        return value
    payload = value[keys[0]]
    if isinstance(payload, str):
        if action == "search":
            payload = {"query": payload}
        elif action == "run":
            payload = {"command": payload}
        elif action == "complete_work":
            payload = {"summary": payload}
        elif action == "read":
            payload = {"paths": payload}
        else:
            payload = {}
    elif isinstance(payload, list):
        if action == "read":
            payload = {"paths": payload}
        elif action == "edit":
            payload = {"operations": payload}
        else:
            payload = {}
    if not isinstance(payload, dict):
        return value
    return {"action": action, **payload}


def _normalize_action_name(value: str) -> str:
    """兼容供应商常见的工具全名和完成动作别名。"""

    aliases = {
        "workspace.search": "search",
        "search_code": "search",
        "code_search": "search",
        "workspace.read": "read",
        "read_file": "read",
        "read_files": "read",
        "code.inspect": "inspect",
        "inspect_file": "inspect",
        "workspace.edit": "edit",
        "edit_file": "edit",
        "write_file": "edit",
        "workspace.write": "edit",
        "write": "edit",
        "create_file": "edit",
        "create": "edit",
        "replace": "edit",
        "update": "edit",
        "patch": "edit",
        "workspace.run": "run",
        "run_command": "run",
        "run_code": "run_code",
        "run_python": "run_code",
        "execute_code": "run_code",
        "software_factory.plan": "factory",
        "software_factory.generate": "factory",
        "software_factory.validate": "factory",
        "software_factory.manifest": "factory",
        "regenerate_manifest": "factory",
        "complete": "complete_work",
        "done": "complete_work",
        "complete_task": "complete_work",
        "task_complete": "complete_work",
        "finish_work": "finish",
    }
    return aliases.get(value, value.rsplit(".", 1)[-1])


def _simple_write_operation(value: dict[str, Any]) -> dict[str, Any] | None:
    """把供应商常见的顶层 write/path/content 结构转换为 edit 操作。"""

    path = str(value.get("path") or "").strip()
    content = None
    for key in _OPERATION_CONTENT_KEYS:
        if value.get(key) is not None:
            content = value[key]
            break
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
        raw = []
        for item in value:
            if isinstance(item, dict):
                raw.append(
                    item.get("path")
                    or item.get("file")
                    or item.get("name")
                    or item.get("target")
                    or ""
                )
            else:
                raw.append(item)
    return list(dict.fromkeys(_clean_path(item) for item in raw if _clean_path(item)))


def _check_batch_size(operations: list[Any]) -> None:
    """单轮编辑内容过大时必须拆批，避免一次请求携带巨型负载。"""

    payload_size = sum(
        len(op.content) + len(op.old_text) + len(op.new_text) for op in operations
    )
    if payload_size > MAX_BATCH_TEXT_CHARS:
        raise ValueError("单轮编辑内容过大，请拆成多个 edit 动作")


def _parse_operations(raw: object) -> list[EditOperation]:
    """解析并校验一批编辑操作（Pydantic Schema 负责字段映射与校验）。"""

    if isinstance(raw, dict):
        raw = [raw]
    if not isinstance(raw, list):
        raise ValueError("edit 动作 operations 必须是数组")
    if not raw:
        # 空 operations 表示“目标已满足，无需修改”，由调用方决定语义，
        # 不再作为硬性协议错误（批量直写提示词明确允许这种表达）。
        return []
    operations: list[EditOperation] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("编辑操作必须是 JSON 对象")
        operations.append(EditOperationModel.model_validate(item).to_domain())
    _check_batch_size(operations)
    return operations


def parse_agent_action(text: str) -> AgentAction:
    """把模型输出解析成严格的单动作协议。"""

    request = ActionRequestModel.model_validate(_extract_json(text))
    action = request.action
    if action == "search":
        return AgentAction(action="search", work_id=request.work_id, query=request.query[:1000])

    if action == "read":
        return AgentAction(
            action="read",
            work_id=request.work_id,
            paths=request.paths,
            offsets=request.offsets,
        )

    if action == "inspect":
        return AgentAction(
            action="inspect",
            work_id=request.work_id,
            paths=request.paths,
            query=request.query[:1000],
        )

    if action == "factory":
        return AgentAction(
            action="factory",
            work_id=request.work_id,
            factory_mode=request.mode,
            factory_domain_id=str(request.domain_id or default_factory_domain_id()).strip()[:100],
            factory_output_root=request.output_root,
            factory_mock_count=request.mock_count,
            factory_overwrite=request.overwrite,
            summary=(request.summary or "执行 Software Factory")[:2000],
        )

    if action == "edit":
        return AgentAction(
            action="edit",
            work_id=request.work_id,
            operations=[operation.to_domain() for operation in (request.operations or [])],
            summary=(request.summary or "执行一批代码修改")[:2000],
        )

    if action == "run":
        return AgentAction(action="run", work_id=request.work_id, command=request.command[:2000])

    if action == "run_code":
        return AgentAction(
            action="run_code",
            work_id=request.work_id,
            code=request.code[:200_000],
        )

    if action == "mcp":
        return AgentAction(
            action="mcp",
            work_id=request.work_id,
            tool=request.tool.strip()[:300],
            arguments=dict(request.arguments or {}),
        )

    if action == "complete_work":
        return AgentAction(
            action="complete_work",
            work_id=request.work_id,
            summary=(request.summary or "工作项已完成")[:4000],
        )

    return AgentAction(
        action="finish",
        summary=(request.summary or "任务已完成")[:8000],
        tests=request.tests[:30],
    )
