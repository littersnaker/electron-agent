"""本地项目文件索引模块。"""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from pathlib import Path

from backend.services.workspace.database import open_database
from backend.services.workspace.repository import (
    resolve_project_root,
    update_project_index_state,
)
from backend.services.workspace.search_terms import extract_search_terms
from backend.utils.paths import is_build_output_segment, is_probably_binary
from backend.utils.sensitive_paths import is_sensitive_workspace_path

IGNORED_DIRECTORIES = {
    ".git",
    ".idea",
    ".vscode",
    ".next",
    ".next-electron",
    ".electron",
    "node_modules",
    ".pnpm-store",
    "dist",
    "build",
    "release",
    "coverage",
    "__pycache__",
    ".venv",
    "venv",
    ".local-data",
    ".agent-data",
    ".python-build",
    ".python-spec",
    "python-dist",
}

TEXT_EXTENSIONS = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".json",
    ".md",
    ".txt",
    ".css",
    ".scss",
    ".html",
    ".yml",
    ".yaml",
    ".toml",
    ".ini",
    ".sh",
    ".ps1",
    ".sql",
}


def iter_project_files(root: Path):
    """按忽略目录剪枝地遍历项目相对路径。

    使用 ``os.walk`` 在进入目录前直接剪掉 node_modules、.pnpm-store 等巨型目录，
    避免 ``rglob`` 先全量遍历再过滤带来的秒级浪费。
    """

    resolved_root = Path(root).resolve()
    for current, dirs, files in os.walk(resolved_root, followlinks=False):
        dirs[:] = sorted(
            directory
            for directory in dirs
            if directory not in IGNORED_DIRECTORIES
            and not is_build_output_segment(directory)
        )
        for name in sorted(files):
            path = Path(current) / name
            try:
                relative = path.relative_to(resolved_root).as_posix()
            except ValueError:
                continue
            if path.is_symlink():
                continue
            yield relative

MAX_INDEX_FILE_BYTES = 1_000_000
MAX_INDEX_CONTENT_CHARS = 200_000


@dataclass(slots=True)
class IndexedFile:
    """准备写入 SQLite 的单个文本文件。"""

    relative_path: str
    content: str
    size: int
    modified_at: float


def _should_index(path: Path) -> bool:
    """判断文件是否适合放入文本索引。

    符号链接可能指向项目目录外部；环境变量文件可能包含 API Key，二者都不进入
    发送给模型的上下文。
    """

    if path.is_symlink() or is_sensitive_workspace_path(path.name):
        return False
    if path.suffix.lower() not in TEXT_EXTENSIONS:
        return False
    try:
        if path.stat().st_size > MAX_INDEX_FILE_BYTES:
            return False
    except OSError:
        return False
    return not is_probably_binary(path)


def _read_index_file(root: Path, path: Path) -> IndexedFile | None:
    """读取一个文本文件并转换成索引记录。"""

    if not _should_index(path):
        return None
    try:
        stat = path.stat()
        content = path.read_text("utf-8", errors="replace")[:MAX_INDEX_CONTENT_CHARS]
        relative = path.relative_to(root).as_posix()
    except (OSError, ValueError):
        return None
    return IndexedFile(relative, content, stat.st_size, stat.st_mtime)


def _collect_files(root: Path) -> list[IndexedFile]:
    """递归扫描工作区并收集可索引文件。"""

    records: list[IndexedFile] = []
    for relative in iter_project_files(root):
        path = root / relative
        record = _read_index_file(root, path)
        if record:
            records.append(record)
    return records


async def index_project(project_id: str) -> dict[str, object]:
    """重建项目文件索引并返回前端可显示的结果。"""

    root = await resolve_project_root(project_id)
    await update_project_index_state(project_id, status="indexing")
    try:
        records = await asyncio.to_thread(_collect_files, root)
        async with open_database() as connection:
            await connection.execute(
                "DELETE FROM file_index WHERE project_id = ?", (project_id,)
            )
            await connection.executemany(
                "INSERT INTO file_index "
                "(project_id, relative_path, content, size, modified_at) "
                "VALUES (?, ?, ?, ?, ?)",
                [
                    (
                        project_id,
                        record.relative_path,
                        record.content,
                        record.size,
                        record.modified_at,
                    )
                    for record in records
                ],
            )
        await update_project_index_state(
            project_id, status="ready", file_count=len(records)
        )
        return {"ok": True, "indexedFileCount": len(records)}
    except Exception:
        await update_project_index_state(project_id, status="error")
        raise


def _query_terms(query: str) -> list[str]:
    """兼容旧调用名称，统一使用中英文搜索词提取器。"""

    return extract_search_terms(query)


async def search_project_index(
    project_id: str, query: str, *, limit: int = 10
) -> list[dict[str, object]]:
    """在项目索引中搜索最相关文件，并返回索引中的完整内容。"""

    terms = _query_terms(query)
    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT relative_path, content, size FROM file_index WHERE project_id = ?",
            (project_id,),
        )
        rows = await cursor.fetchall()

    scored: list[tuple[int, dict[str, object]]] = []
    for row in rows:
        path = str(row["relative_path"])
        content = str(row["content"])
        haystack = f"{path}\n{content}".lower()
        score = sum(haystack.count(term) * (5 if term in path.lower() else 1) for term in terms)
        if not terms:
            score = 1
        if score <= 0:
            continue
        scored.append(
            (
                score,
                {
                    "path": path,
                    "size": int(row["size"]),
                    "content": content,
                    "score": score,
                },
            )
        )
    scored.sort(key=lambda item: item[0], reverse=True)
    return [item[1] for item in scored[:limit]]
