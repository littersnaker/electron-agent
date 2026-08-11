"""Code Agent 工作区搜索、读取与事务式编辑工具。"""

from __future__ import annotations

import difflib
import hashlib
from dataclasses import dataclass, field
from pathlib import Path

from backend.services.agent.shared.icon_assets import backfill_placeholder_icons
from backend.services.agent.shared.loop_protocol import EditOperation
from backend.services.workspace.indexer import TEXT_EXTENSIONS, iter_project_files
from backend.services.workspace.search_terms import extract_search_terms
from backend.utils.paths import is_probably_binary, resolve_inside
from backend.utils.sensitive_paths import (
    is_sensitive_workspace_path,
    partition_safe_workspace_paths,
    render_sensitive_skip,
)

MAX_SEARCH_FILE_BYTES = 1_500_000
MAX_WRITE_FILE_CHARS = 2_000_000
MAXIMUM_SOURCE_LINES = 500
LINE_LIMITED_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx"}




@dataclass(slots=True)
class ReadBatchResult:
    """一批文件读取结果及读取时的内容指纹。"""

    content: str
    versions: dict[str, str]
    blocked_paths: list[str] = field(default_factory=list)
    # path -> 该文件的独立内容块（含 --- path --- 头），供调用方做
    # “未变化文件不重复注入”的瘦身，同时保证变化文件仍拿到完整内容。
    contents: dict[str, str] = field(default_factory=dict)


@dataclass(slots=True)
class EditBatchResult:
    """一批编辑执行后的真实结果。"""

    changed_files: list[str]
    deleted_files: list[str]
    diff_preview: str


def _iter_text_files(root: Path):
    """遍历可安全提供给模型的文本文件。"""

    for relative in iter_project_files(root):
        path = root / relative
        if is_sensitive_workspace_path(relative):
            continue
        if path.suffix.lower() not in TEXT_EXTENSIONS:
            continue
        try:
            if path.stat().st_size > MAX_SEARCH_FILE_BYTES:
                continue
        except OSError:
            continue
        if not is_probably_binary(path):
            yield path


def render_workspace_tree(root: Path, *, limit: int | None = None) -> str:
    """返回紧凑的项目目录树，帮助模型先理解代码库结构。"""

    lines: list[str] = []
    for relative in iter_project_files(root):
        if is_sensitive_workspace_path(relative):
            continue
        lines.append(relative)
        if limit is not None and len(lines) >= limit:
            lines.append("（目录树已按调用方要求截断，可继续使用 search/read 工具）")
            break
    return "\n".join(lines) or "（项目目录中没有可见文件）"


def _query_terms(query: str) -> list[str]:
    """提取用于磁盘搜索的中英文关键词。"""

    return extract_search_terms(query, limit=36)


def search_workspace(root: Path, query: str, *, limit: int = 24) -> str:
    """直接搜索当前磁盘内容，确保能看见刚刚写入的代码。"""

    terms = _query_terms(query)
    if not terms:
        return "搜索词过短，请提供文件名、符号名或更具体的关键词。"

    matches: list[tuple[int, str]] = []
    for path in _iter_text_files(root):
        try:
            content = path.read_text("utf-8", errors="replace")
            relative = path.relative_to(root).as_posix()
        except (OSError, ValueError):
            continue
        path_lower = relative.lower()
        content_lower = content.lower()
        score = sum(
            (8 if term in path_lower else 0) + min(content_lower.count(term), 20)
            for term in terms
        )
        if score <= 0:
            continue
        snippet_lines: list[str] = []
        for number, line in enumerate(content.splitlines(), start=1):
            if any(term in line.lower() for term in terms):
                snippet_lines.append(f"{number}: {line[:320]}")
            if len(snippet_lines) >= 8:
                break
        snippet = "\n".join(snippet_lines) or "（仅文件路径匹配）"
        matches.append((score, f"--- {relative} ---\n{snippet}"))

    matches.sort(key=lambda item: item[0], reverse=True)
    if not matches:
        return "没有找到匹配文件。请换关键词或使用 read 读取已知路径。"
    return "\n\n".join(item[1] for item in matches[:limit])


def score_workspace_paths(
    root: Path,
    query: str,
    *,
    limit: int = 24,
) -> list[str]:
    """按“路径 + 文件内容”命中度给工作区文本文件打分，返回相对路径列表。

    中文请求（如“购物车”）能命中文件里的中文文案，从而把 `CartPage.tsx`
    这类英文命名文件映射到任务；用于 Planner 前置筛查与 WorkList 异常检测。
    """

    terms = _query_terms(query)
    if not terms:
        return []
    scored: list[tuple[int, str]] = []
    seen: set[str] = set()
    for path in _iter_text_files(root):
        try:
            content = path.read_text("utf-8", errors="replace")
        except OSError:
            continue
        relative = path.relative_to(root).as_posix()
        path_lower = relative.lower()
        content_lower = content.lower()
        score = sum(
            (8 if term in path_lower else 0)
            + min(content_lower.count(term), 20)
            for term in terms
        )
        if score <= 0 or relative in seen:
            continue
        seen.add(relative)
        scored.append((score, relative))
    scored.sort(key=lambda item: item[0], reverse=True)
    return [relative for _score, relative in scored[:limit]]


def file_version(root: Path, relative_path: str) -> str:
    """返回工作区文件内容指纹；敏感路径不读取内容并返回稳定标记。"""

    if is_sensitive_workspace_path(relative_path):
        return "blocked-sensitive"
    target = resolve_inside(root, relative_path)
    if not target.exists():
        return "missing"
    if not target.is_file():
        return "not-file"
    try:
        return hashlib.sha256(target.read_bytes()).hexdigest()
    except OSError:
        return "unreadable"


def read_workspace_files_with_versions(
    root: Path,
    paths: list[str],
    offsets: dict[str, int] | None = None,
) -> ReadBatchResult:
    """读取安全文本文件，并把敏感路径转换为非致命的过滤提示。

    ``offsets`` 提供 path -> 字符偏移 的映射，用于超大文件分页查看；
    单次任务内不做内容截断，模型始终拿到文件完整内容。
    """

    safe_paths, blocked_paths = partition_safe_workspace_paths(paths)
    offsets = offsets or {}
    sections: list[str] = []
    contents: dict[str, str] = {}
    skip_message = render_sensitive_skip(blocked_paths)
    if skip_message:
        sections.append(skip_message)
    versions: dict[str, str] = {}
    for relative_path in safe_paths:
        versions[relative_path] = file_version(root, relative_path)
        target = resolve_inside(root, relative_path)
        if not target.exists():
            section = f"--- {relative_path} ---\n（文件不存在）"
            sections.append(section)
            contents[relative_path] = section
            continue
        if not target.is_file() or is_probably_binary(target):
            section = f"--- {relative_path} ---\n（不是可读取的文本文件）"
            sections.append(section)
            contents[relative_path] = section
            continue
        try:
            content = target.read_text("utf-8", errors="replace")
        except OSError as exc:
            section = f"--- {relative_path} ---\n（读取失败：{exc}）"
            sections.append(section)
            contents[relative_path] = section
            continue
        offset = max(0, int(offsets.get(relative_path) or 0))
        included = content[offset:]
        offset_note = f"（从字符 {offset} 续读）" if offset > 0 else ""
        section = f"--- {relative_path} ---{offset_note}\n{included}"
        sections.append(section)
        contents[relative_path] = section
    return ReadBatchResult("\n\n".join(sections), versions, blocked_paths, contents)


def read_workspace_files(root: Path, paths: list[str]) -> str:
    """兼容旧调用方，仅返回读取文本。"""

    return read_workspace_files_with_versions(root, paths).content


def _validate_written_content(target: Path, relative_path: str, content: str) -> None:
    """限制单文件大小与手写源码行数，防止异常模型输出。"""

    if len(content) > MAX_WRITE_FILE_CHARS:
        raise ValueError(f"文件内容过大，拒绝写入：{relative_path}")
    if (
        target.suffix.lower() in LINE_LIMITED_SUFFIXES
        and len(content.splitlines()) > MAXIMUM_SOURCE_LINES
    ):
        raise ValueError(
            f"文件 {relative_path} 超过 {MAXIMUM_SOURCE_LINES} 行，请拆分模块后再写入"
        )


def _apply_operation(target: Path, operation: EditOperation) -> tuple[str, str]:
    """执行单个写入、精确替换或删除操作，并返回修改前后文本。"""

    before = target.read_text("utf-8", errors="replace") if target.exists() else ""
    if operation.type == "delete":
        if target.exists():
            target.unlink()
        return before, ""

    if operation.type == "write":
        after = operation.content
    else:
        if not target.exists():
            raise ValueError(f"replace 目标文件不存在：{operation.path}")
        occurrences = before.count(operation.old_text)
        if occurrences == 0:
            hint = _nearby_text_hint(before, operation.old_text)
            raise ValueError(
                f"replace 未找到精确旧文本：{operation.path}"
                + (f"；{hint}" if hint else "")
            )
        count = -1 if operation.replace_all else 1
        after = before.replace(operation.old_text, operation.new_text, count)

    _validate_written_content(target, operation.path, after)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(after, encoding="utf-8", newline="")
    return before, after


def _nearby_text_hint(before: str, needle: str) -> str:
    """在精确替换失败时，返回与 oldText 最相似位置的上下文行，供模型修正。"""

    if not needle or not before:
        return ""
    lines = before.splitlines()
    if not lines:
        return ""
    needle_compact = "".join(needle.split())[:200]
    if not needle_compact:
        return ""
    best_index = 0
    best_score = -1.0
    for index, line in enumerate(lines[:2_000]):
        line_compact = "".join(line.split())[:200]
        if not line_compact:
            continue
        score = difflib.SequenceMatcher(None, line_compact, needle_compact).ratio()
        if score > best_score:
            best_score = score
            best_index = index
    start = max(0, best_index - 3)
    end = min(len(lines), best_index + 4)
    context = "\n".join(
        f"{number}: {line}"
        for number, line in enumerate(lines[start:end], start=start + 1)
    )
    return f"最接近的代码块（行 {start + 1}~{end}）:\n{context[:1_500]}"


def apply_edit_operations(
    root: Path,
    operations: list[EditOperation],
    *,
    expected_versions: dict[str, str] | None = None,
) -> EditBatchResult:
    """事务式应用编辑，并拒绝覆盖并行 Work 已经改动的旧文件版本。"""

    expected_versions = expected_versions or {}
    backups: dict[Path, bytes | None] = {}
    changed: list[str] = []
    deleted: list[str] = []
    previews: list[str] = []
    try:
        for operation in operations:
            target = resolve_inside(root, operation.path)
            expected = expected_versions.get(operation.path)
            if expected is not None:
                current = file_version(root, operation.path)
                if current != expected:
                    raise ValueError(
                        f"内容已变化：{operation.path} 自上次读取后已被修改"
                        "（可能来自本 Work 此前的编辑或并行写入），请重新 read 后再生成补丁"
                    )
            if target not in backups:
                backups[target] = target.read_bytes() if target.exists() else None
            before, after = _apply_operation(target, operation)
            if before == after:
                continue
            if operation.path not in changed:
                changed.append(operation.path)
            if operation.type == "delete":
                deleted.append(operation.path)
            diff = difflib.unified_diff(
                before.splitlines(),
                after.splitlines(),
                fromfile=f"a/{operation.path}",
                tofile=f"b/{operation.path}",
                lineterm="",
                n=3,
            )
            previews.append("\n".join(list(diff)[:240]))
    except Exception:
        for target, previous in reversed(list(backups.items())):
            if previous is None:
                target.unlink(missing_ok=True)
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(previous)
        raise

    created_icons = backfill_placeholder_icons(root, changed)
    for icon_path in created_icons:
        if icon_path not in changed:
            changed.append(icon_path)
    preview = "\n\n".join(item for item in previews if item)
    if created_icons:
        icon_note = "（自动补齐占位图标：" + "、".join(created_icons) + "）"
        preview = (preview + "\n" + icon_note) if preview else icon_note
    if len(preview) > 80_000:
        preview = f"{preview[:80_000]}\n（差异预览已截断）"
    return EditBatchResult(changed, deleted, preview or "（文件内容没有实际变化）")
