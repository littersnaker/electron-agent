"""Code Agent 多轮工具协议解析与约束。

模型每一轮只能选择一个工具动作。后端执行动作后把真实结果返回给下一轮，
从而避免旧版“一次生成全部文件”的脆弱工作方式。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Literal


ActionKind = Literal["search", "read", "edit", "run", "complete_work", "finish"]
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
    operations: list[EditOperation] = field(default_factory=list)
    command: str = ""
    summary: str = ""
    tests: list[str] = field(default_factory=list)


def _extract_json(text: str) -> dict[str, Any]:
    """从模型回复中提取第一个完整 JSON 对象。"""

    stripped = text.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", stripped, re.IGNORECASE)
    candidate = fenced.group(1).strip() if fenced else stripped
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start < 0 or end < start:
        raise ValueError("模型没有返回代理工具 JSON")
    try:
        value = json.loads(candidate[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError(f"代理工具 JSON 无效：{exc.msg}") from exc
    if not isinstance(value, dict):
        raise ValueError("代理工具响应必须是 JSON 对象")
    return value


def _clean_path(value: object) -> str:
    """清洗模型返回的工作区相对路径。"""

    return str(value or "").strip().replace("\\", "/")


def _parse_operations(raw: object) -> list[EditOperation]:
    """解析并校验一批编辑操作。"""

    if not isinstance(raw, list) or not raw:
        raise ValueError("edit 动作必须包含非空 operations")
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
        if operation_type == "write" and not isinstance(item.get("content"), str):
            raise ValueError(f"write 操作缺少 content：{path}")
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
    if action not in {"search", "read", "edit", "run", "complete_work", "finish"}:
        raise ValueError(f"未知代理动作：{action or '空'}")

    work_id = str(raw.get("workId") or raw.get("work_id") or "").strip().upper()[:40]

    if action == "search":
        query = str(raw.get("query") or "").strip()
        if not query:
            raise ValueError("search 动作缺少 query")
        return AgentAction(action="search", work_id=work_id, query=query[:1000])

    if action == "read":
        raw_paths = raw.get("paths")
        if not isinstance(raw_paths, list) or not raw_paths:
            raise ValueError("read 动作必须包含 paths")
        paths = list(dict.fromkeys(_clean_path(item) for item in raw_paths if _clean_path(item)))
        return AgentAction(action="read", work_id=work_id, paths=paths)

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
