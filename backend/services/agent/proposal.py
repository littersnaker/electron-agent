"""文件修改提案生成、校验与应用模块。"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage, LlmUsage
from backend.utils.paths import resolve_inside


LINE_LIMITED_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx", ".md"}
MAXIMUM_SOURCE_LINES = 500


@dataclass(slots=True)
class ProposedFile:
    """模型提出的单个完整文件修改。"""

    path: str
    content: str
    reason: str
    existed: bool


@dataclass(slots=True)
class ChangeProposal:
    """一轮 Code Agent 文件修改提案。"""

    summary: str
    files: list[ProposedFile]
    usage: LlmUsage
    model_name: str


def _extract_json(text: str) -> dict[str, Any]:
    """从模型回复中提取 JSON 对象。"""

    stripped = text.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", stripped, re.IGNORECASE)
    candidate = fenced.group(1).strip() if fenced else stripped
    start = candidate.find("{")
    end = candidate.rfind("}")
    if start < 0 or end < start:
        raise ValueError("模型没有返回可解析的文件修改 JSON")
    try:
        value = json.loads(candidate[start : end + 1])
    except json.JSONDecodeError as exc:
        raise ValueError(f"模型返回的文件修改 JSON 无效：{exc.msg}") from exc
    if not isinstance(value, dict):
        raise ValueError("文件修改提案必须是 JSON 对象")
    return value


def _validate_proposal(root: Path, raw: dict[str, Any], usage: LlmUsage, model_name: str) -> ChangeProposal:
    """校验模型提案中的路径与文本大小；不再设置 8 文件硬限制。"""

    raw_files = raw.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise ValueError("模型没有给出任何文件修改")
    files: list[ProposedFile] = []
    seen: set[str] = set()
    for item in raw_files:
        if not isinstance(item, dict):
            continue
        relative_path = str(item.get("path") or "").strip().replace("\\", "/")
        content = item.get("content")
        reason = str(item.get("reason") or "按用户要求修改")
        if not relative_path or not isinstance(content, str):
            continue
        target = resolve_inside(root, relative_path)
        if relative_path in seen:
            raise ValueError(f"模型重复修改同一个文件：{relative_path}")
        if len(content) > 1_500_000:
            raise ValueError(f"文件内容过大，拒绝写入：{relative_path}")
        if (
            target.suffix.lower() in LINE_LIMITED_SUFFIXES
            and len(content.splitlines()) > MAXIMUM_SOURCE_LINES
        ):
            raise ValueError(
                f"文件 {relative_path} 超过 {MAXIMUM_SOURCE_LINES} 行，请先拆分模块"
            )
        seen.add(relative_path)
        files.append(ProposedFile(relative_path, content, reason, target.exists()))

    if not files:
        raise ValueError("模型提案中没有合法文件")
    summary = str(raw.get("summary") or "已生成文件修改提案")
    return ChangeProposal(summary, files, usage, model_name)


async def generate_proposal(
    *,
    root: Path,
    user_request: str,
    context_text: str,
    preferred_model_id: str,
    credentials: LlmCredentials,
) -> ChangeProposal:
    """让模型输出受严格 JSON 约束的完整文件修改提案。"""

    system = """你是谨慎的代码修改 Agent。请根据用户需求和文件上下文返回 JSON，禁止 Markdown 解释。
JSON 结构必须是：
{"summary":"修改摘要","files":[{"path":"相对项目根目录的路径","content":"修改后的完整文件内容","reason":"原因"}]}
规则：只修改完成任务必需的文件；文件总数不设 8 个硬限制；不要输出二进制文件；不要使用绝对路径；保留现有功能；每个手写代码文件尽量少于 500 行。"""
    prompt = f"用户需求：\n{user_request}\n\n项目上下文：\n{context_text}"
    text, usage, model = await GATEWAY.complete(
        preferred_model_id=preferred_model_id,
        credentials=credentials,
        messages=[LlmMessage("system", system), LlmMessage("user", prompt)],
        temperature=0.1,
        audit={"agentRole": "proposal"},
    )
    return _validate_proposal(root, _extract_json(text), usage, model.name)


def proposal_to_json(proposal: ChangeProposal) -> dict[str, Any]:
    """把内存中的提案转换成可保存到 SQLite 的 JSON 对象。"""

    return {
        "summary": proposal.summary,
        "modelName": proposal.model_name,
        "usage": {
            "prompt": proposal.usage.prompt,
            "completion": proposal.usage.completion,
            "total": proposal.usage.total,
        },
        "files": [
            {
                "path": item.path,
                "content": item.content,
                "reason": item.reason,
                "existed": item.existed,
            }
            for item in proposal.files
        ],
    }


def apply_proposal(root: Path, raw: dict[str, Any]) -> list[str]:
    """把已经获得用户批准的提案安全写入工作区。"""

    changed: list[str] = []
    raw_files = raw.get("files")
    if not isinstance(raw_files, list):
        raise ValueError("待批准提案缺少 files 字段")

    backups: list[tuple[Path, bytes | None]] = []
    try:
        for item in raw_files:
            if not isinstance(item, dict):
                continue
            relative_path = str(item.get("path") or "")
            content = item.get("content")
            if not isinstance(content, str):
                continue
            target = resolve_inside(root, relative_path)
            previous = target.read_bytes() if target.exists() else None
            backups.append((target, previous))
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8", newline="")
            changed.append(relative_path)
    except Exception:
        for target, previous in reversed(backups):
            if previous is None:
                target.unlink(missing_ok=True)
            else:
                target.write_bytes(previous)
        raise
    return changed
