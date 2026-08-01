"""Code Agent 工作区上下文构建模块。"""

from __future__ import annotations

from pathlib import Path

from backend.services.workspace.indexer import (
    IGNORED_DIRECTORIES,
    TEXT_EXTENSIONS,
    index_project,
    search_project_index,
)
from backend.services.workspace.repository import get_project
from backend.utils.paths import is_probably_binary

OVERVIEW_EXACT_NAMES = {
    "package.json",
    "pyproject.toml",
    "requirements.txt",
    "requirements-dev.txt",
    "cargo.toml",
    "go.mod",
    "readme.md",
    "readme_cn.md",
    "app.json",
    "project.config.json",
    "electron-builder.yml",
}
OVERVIEW_PATH_TOKENS = (
    "route",
    "router",
    "schema",
    "database",
    "store",
    "api",
    "page",
    "main",
    "app",
    "config",
)
MAX_OVERVIEW_FILES = 12
MAX_OVERVIEW_FILE_CHARS = 8_000


def _overview_score(relative_path: str) -> int:
    """为项目概览文件计算稳定优先级。"""

    normalized = relative_path.lower()
    name = Path(normalized).name
    score = 100 if name in OVERVIEW_EXACT_NAMES else 0
    score += sum(12 for token in OVERVIEW_PATH_TOKENS if token in normalized)
    if score <= 0:
        return 0
    depth = normalized.count("/")
    return score + max(0, 12 - depth * 2)


def _fallback_overview_files(root: Path) -> list[dict[str, object]]:
    """索引关键词无命中时读取项目清单、入口和核心结构文件。"""

    candidates: list[tuple[int, Path]] = []
    for path in root.rglob("*"):
        if any(part in IGNORED_DIRECTORIES for part in path.parts):
            continue
        if not path.is_file() or path.is_symlink():
            continue
        if path.name == ".env" or path.name.startswith(".env."):
            continue
        if path.suffix.lower() not in TEXT_EXTENSIONS and path.name.lower() not in OVERVIEW_EXACT_NAMES:
            continue
        try:
            relative = path.relative_to(root).as_posix()
            if path.stat().st_size > 500_000 or is_probably_binary(path):
                continue
        except (OSError, ValueError):
            continue
        score = _overview_score(relative)
        if score > 0:
            candidates.append((score, path))

    candidates.sort(key=lambda item: (-item[0], item[1].as_posix().lower()))
    result: list[dict[str, object]] = []
    for score, path in candidates[:MAX_OVERVIEW_FILES]:
        try:
            relative = path.relative_to(root).as_posix()
            content = path.read_text("utf-8", errors="replace")[:MAX_OVERVIEW_FILE_CHARS]
            size = path.stat().st_size
        except (OSError, ValueError):
            continue
        result.append(
            {
                "path": relative,
                "content": content,
                "size": size,
                "score": score,
                "fallback": True,
            }
        )
    return result


async def ensure_context(
    project_id: str,
    query: str,
) -> tuple[Path, list[dict[str, object]]]:
    """确保项目已有索引，并返回工作区根目录和相关文件。"""

    project = await get_project(project_id)
    root = Path(project.root_path).resolve()
    if project.index_status != "ready" or project.indexed_file_count == 0:
        await index_project(project_id)
    files = await search_project_index(project_id, query, limit=12)
    if not files:
        files = _fallback_overview_files(root)
    return root, files


def render_context(files: list[dict[str, object]]) -> str:
    """把搜索结果转换成适合放入模型上下文的文本。"""

    if not files:
        return "（索引未命中；后续必须使用 search/read 工具检查真实项目文件。）"
    sections: list[str] = []
    for item in files:
        path = str(item.get("path") or "unknown")
        content = str(item.get("content") or "")
        source = "结构概览回退" if item.get("fallback") else "索引匹配"
        sections.append(f"--- FILE: {path} [{source}] ---\n{content}")
    return "\n\n".join(sections)
