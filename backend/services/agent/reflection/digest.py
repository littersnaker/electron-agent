"""从审计日志与 Work 结果构建紧凑复盘材料（源头脱敏 + 信息量阈值）。"""

from __future__ import annotations

import re
from typing import Any

from backend.core import request_audit

MIN_DIGEST_CHARS = 120
MAX_AUDIT_ENTRIES = 20
MAX_ENTRY_CHARS = 400
MAX_TRANSCRIPT_LINES = 8

_PII_PATTERNS = (
    re.compile(r"(?i)\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b"),
    re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)"),
    re.compile(r"(?<!\d)\d{17}[\dXx](?!\d)"),
    re.compile(
        r"(?i)\b(?:name|user|username|phone|email|address|order[_-]?id|customer)"
        r"\s*[:=]\s*['\"]?[a-z0-9._@/-]{6,}"
    ),
)


def sanitize_digest_text(value: str) -> str:
    """对复盘材料做伪匿名：身份字段/联系方式替换为占位符，保留业务模式。"""

    result = value
    for pattern in _PII_PATTERNS:
        result = pattern.sub("[REDACTED]", result)
    return result


def _compact_entry(entry: dict[str, Any], max_chars: int = MAX_ENTRY_CHARS) -> str:
    """把一条审计记录压缩成一行可读摘要。"""

    request = entry.get("request") or {}
    response = entry.get("response") or {}
    model = str(request.get("model") or "")
    status = str(entry.get("status") or "")
    duration = int(entry.get("durationMs") or 0)
    error = str(entry.get("error") or "")
    text = str(response.get("text") or "")
    if len(text) > max_chars:
        text = f"{text[:max_chars]}...[truncated]"
    if error and len(error) > 300:
        error = f"{error[:300]}...[truncated]"
    parts = [f"  - {entry.get('kind')} {model} status={status} {duration}ms"]
    if text:
        parts.append(f"    text: {text}")
    if error:
        parts.append(f"    error: {error}")
    return "\n".join(parts)


def _related_audit_entries(
    *,
    work_id: str,
    audit_dir: str | None = None,
) -> list[dict[str, Any]]:
    """按 parentRequestId / agentId 前缀捞取某个 Work 的完整执行轨迹。"""

    matching: list[dict[str, Any]] = []
    prefix_ids = (
        f"modify_worker:{work_id}",
        f"batch_write:{work_id}",
        f"generate_all:{work_id}",
    )
    for entry in request_audit.iter_entries(audit_dir):
        agent = entry.get("agent") or {}
        if not isinstance(agent, dict):
            continue
        parent = str(agent.get("parentRequestId") or "")
        agent_id = str(agent.get("agentId") or "")
        if parent == work_id or agent_id.startswith(prefix_ids):
            matching.append(entry)
    matching.sort(key=lambda item: str(item.get("timestamp") or ""))
    return matching[-MAX_AUDIT_ENTRIES:]


def build_work_digest(
    *,
    work_id: str,
    succeeded: bool,
    summary: str,
    error: str,
    failure_kind: str,
    changed_files: list[str],
    transcript_tail: list[str],
    project_id: str,
    audit_dir: str | None = None,
) -> str | None:
    """构造复盘输入；信息量不足时返回 None（跳过本轮复盘）。"""

    sections: list[str] = [
        f"WORK: {work_id} (project={project_id or 'unknown'})",
        f"RESULT: {'SUCCESS' if succeeded else 'FAILED'} kind={failure_kind or 'none'}",
    ]
    if summary:
        sections.append(f"SUMMARY: {summary[:500]}")
    if error:
        sections.append(f"ERROR: {error[:500]}")
    if changed_files:
        files = ", ".join(str(item) for item in changed_files[:12])
        sections.append(f"CHANGED_FILES: {files}")
    if transcript_tail:
        tail_lines = [str(line)[:300] for line in transcript_tail[-MAX_TRANSCRIPT_LINES:]]
        sections.append(
            "TRANSCRIPT_TAIL:\n"
            + "\n".join(f"  {line}" for line in tail_lines)
        )

    entries = _related_audit_entries(work_id=work_id, audit_dir=audit_dir)
    if entries:
        sections.append("AUDIT_TRAIL:")
        sections.extend(_compact_entry(entry) for entry in entries)

    digest = sanitize_digest_text("\n".join(sections)).strip()
    if len(digest) < MIN_DIGEST_CHARS:
        return None
    return digest


def build_runtime_digest(
    *,
    task_id: str,
    agent_id: str,
    status: str,
    request_text: str,
    result_summary: str,
    error_message: str,
    event_count: int,
    project_id: str,
    session_id: str,
    marketplace: str,
    audit_dir: str | None = None,
) -> str | None:
    """为统一 Runtime（电商/其他 Agent）构造复盘材料。

    电商场景的业务模式（平台规则、状态流转、异常码）完整保留，
    身份字段（客户、订单号、联系方式）在源头剔除/伪匿名。
    """

    sections: list[str] = [
        f"TASK: {task_id} agent={agent_id} status={status}",
        f"REQUEST: {(request_text or '')[:500]}",
    ]
    if marketplace:
        sections.append(f"MARKETPLACE: {marketplace}")
    if session_id:
        sections.append(f"SESSION: {session_id[:80]}")
    if project_id:
        sections.append(f"PROJECT: {project_id[:80]}")
    if result_summary:
        sections.append(f"RESULT: {result_summary[:800]}")
    if error_message:
        sections.append(f"ERROR: {error_message[:500]}")
    if event_count:
        sections.append(f"EVENTS: {event_count}")

    entries = [
        entry
        for entry in request_audit.iter_entries(audit_dir)
        if isinstance(entry.get("agent") or {}, dict)
        and (entry.get("agent") or {}).get("parentRequestId") == task_id
    ]
    entries.sort(key=lambda item: str(item.get("timestamp") or ""))
    entries = entries[-MAX_AUDIT_ENTRIES:]
    if entries:
        sections.append("AUDIT_TRAIL:")
        sections.extend(_compact_entry(entry) for entry in entries)

    digest = sanitize_digest_text("\n".join(sections)).strip()
    if len(digest) < MIN_DIGEST_CHARS:
        return None
    return digest
