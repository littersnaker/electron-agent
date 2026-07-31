"""Code Agent 工作区上下文构建模块。"""

from __future__ import annotations

from pathlib import Path

from backend.services.workspace.indexer import index_project, search_project_index
from backend.services.workspace.repository import get_project


async def ensure_context(project_id: str, query: str) -> tuple[Path, list[dict[str, object]]]:
    """确保项目已有索引，并返回工作区根目录和相关文件。"""

    project = await get_project(project_id)
    if project.index_status != "ready" or project.indexed_file_count == 0:
        await index_project(project_id)
    files = await search_project_index(project_id, query, limit=10)
    return Path(project.root_path).resolve(), files


def render_context(files: list[dict[str, object]]) -> str:
    """把搜索结果转换成适合放入模型上下文的文本。"""

    if not files:
        return "（索引中没有找到明显相关的文本文件。）"
    sections: list[str] = []
    for item in files:
        path = str(item.get("path") or "unknown")
        content = str(item.get("content") or "")
        sections.append(f"--- FILE: {path} ---\n{content}")
    return "\n\n".join(sections)
