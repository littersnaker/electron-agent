"""Code Agent 工作区搜索、读取与事务式编辑工具。"""

from __future__ import annotations

import difflib
import hashlib
from dataclasses import dataclass
from pathlib import Path

from backend.services.agent.loop_protocol import EditOperation
from backend.services.workspace.indexer import IGNORED_DIRECTORIES, TEXT_EXTENSIONS
from backend.services.workspace.search_terms import extract_search_terms
from backend.utils.paths import is_probably_binary, resolve_inside


MAX_READ_FILE_CHARS = 160_000
MAX_READ_TOTAL_CHARS = 360_000
MAX_SEARCH_FILE_BYTES = 1_500_000
MAX_WRITE_FILE_CHARS = 2_000_000
MAXIMUM_SOURCE_LINES = 500
LINE_LIMITED_SUFFIXES = {".py", ".ts", ".tsx", ".js", ".jsx"}




@dataclass(slots=True)
class ReadBatchResult:
    """一批文件读取结果及读取时的内容指纹。"""

    content: str
    versions: dict[str, str]


@dataclass(slots=True)
class EditBatchResult:
    """一批编辑执行后的真实结果。"""

    changed_files: list[str]
    deleted_files: list[str]
    diff_preview: str


def _iter_text_files(root: Path):
    """遍历可安全提供给模型的文本文件。"""

    for path in root.rglob("*"):
        if any(part in IGNORED_DIRECTORIES for part in path.parts):
            continue
        if not path.is_file() or path.is_symlink():
            continue
        if path.name == ".env" or path.name.startswith(".env."):
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
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix().lower()):
        if any(part in IGNORED_DIRECTORIES for part in path.parts):
            continue
        if path.is_symlink():
            continue
        try:
            relative = path.relative_to(root).as_posix()
        except ValueError:
            continue
        if path.is_dir():
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


def file_version(root: Path, relative_path: str) -> str:
    """返回工作区文件内容指纹；不存在时返回稳定标记。"""

    target = resolve_inside(root, relative_path)
    if not target.exists():
        return "missing"
    if not target.is_file():
        return "not-file"
    try:
        return hashlib.sha256(target.read_bytes()).hexdigest()
    except OSError:
        return "unreadable"


def read_workspace_files_with_versions(root: Path, paths: list[str]) -> ReadBatchResult:
    """读取文件，并记录并行编辑冲突检测所需的内容指纹。"""

    sections: list[str] = []
    versions: dict[str, str] = {}
    consumed = 0
    for relative_path in paths:
        versions[relative_path] = file_version(root, relative_path)
        target = resolve_inside(root, relative_path)
        if not target.exists():
            sections.append(f"--- {relative_path} ---\n（文件不存在）")
            continue
        if not target.is_file() or is_probably_binary(target):
            sections.append(f"--- {relative_path} ---\n（不是可读取的文本文件）")
            continue
        try:
            content = target.read_text("utf-8", errors="replace")
        except OSError as exc:
            sections.append(f"--- {relative_path} ---\n（读取失败：{exc}）")
            continue
        remaining = MAX_READ_TOTAL_CHARS - consumed
        if remaining <= 0:
            sections.append("（本轮读取总量达到上限，请下一轮继续 read）")
            break
        included = content[: min(MAX_READ_FILE_CHARS, remaining)]
        suffix = "\n（文件内容已截断）" if len(included) < len(content) else ""
        sections.append(f"--- {relative_path} ---\n{included}{suffix}")
        consumed += len(included)
    return ReadBatchResult("\n\n".join(sections), versions)


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
            raise ValueError(f"replace 未找到精确旧文本：{operation.path}")
        count = -1 if operation.replace_all else 1
        after = before.replace(operation.old_text, operation.new_text, count)

    _validate_written_content(target, operation.path, after)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(after, encoding="utf-8", newline="")
    return before, after


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
                        f"并行冲突：{operation.path} 在读取后已被其他 Work 修改，"
                        "请重新 read 后再生成补丁"
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

    preview = "\n\n".join(item for item in previews if item)
    if len(preview) > 80_000:
        preview = f"{preview[:80_000]}\n（差异预览已截断）"
    return EditBatchResult(changed, deleted, preview or "（文件内容没有实际变化）")
