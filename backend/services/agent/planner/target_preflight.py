"""Work targetFiles 确定性预检。

Planner 可能把 targetFiles 留空或只填目录，导致批量直写快路径失效、
退回多轮循环并产生大量 Token 消耗。这里在派发前用项目文件清单做一次
纯代码补全：只依赖文件路径/文本关键词，不识别任何业务域。
"""

from __future__ import annotations

import re

from backend.services.agent.work_models import WorkItem
from backend.utils.paths import is_build_output_segment

MAX_PREFLIGHT_FILES = 15

# 与 planner_input 保持一致的无关注录，避免把依赖目录塞进 targetFiles。
IGNORED_DIR_MARKS = {
    "node_modules",
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
    ".next",
    ".electron",
    "release",
    ".uploads",
    ".trae",
    ".agents",
    ".agent-data",
    ".local-data",
}

_SOURCE_EXTENSIONS = {
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".py",
    ".css",
    ".scss",
    ".json",
    ".md",
    ".html",
    ".vue",
    ".sql",
    ".yaml",
    ".yml",
    ".toml",
    ".ini",
}

# 从任务文本中直接提取的类路径 token，例如 "app/cart/CartPage.tsx"。
_PATH_TOKEN = re.compile(
    r"(?<![A-Za-z0-9])([A-Za-z0-9_][A-Za-z0-9_.\-/]*"
    r"\.(?:tsx?|jsx?|py|css|scss|json|js|ts|md|html|vue|sql|yaml|yml|toml|ini))"
    r"(?![\w])",
    re.IGNORECASE,
)
# 通用 ASCII 词（camelCase / kebab-case / 文件名片段）。
_ASCII_WORD = re.compile(r"[A-Za-z][A-Za-z0-9_\-]{2,}")


def extract_tree_paths(project_tree: str) -> list[str]:
    """把 render_workspace_tree 输出的相对路径列表解析成规范路径。"""

    paths: list[str] = []
    seen: set[str] = set()
    for raw in project_tree.splitlines():
        line = raw.strip()
        if (
            not line
            or line.endswith("/")
            or line.startswith("(")
            or line.startswith("（")
        ):
            continue
        path = line.replace("\\", "/").lstrip("./")
        if not path:
            continue
        segments = path.split("/")
        if any(
            segment in IGNORED_DIR_MARKS or is_build_output_segment(segment)
            for segment in segments
        ):
            continue
        if path in seen:
            continue
        seen.add(path)
        paths.append(path)
    return paths


def count_project_source_files(project_tree: str) -> int:
    """统计项目树中的源码/配置文件数量（排除依赖与构建产物）。"""

    return len(extract_tree_paths(project_tree))


def is_greenfield_project(
    project_tree: str,
    *,
    max_source_files: int = 5,
) -> bool:
    """判断是否"从零构建"：项目里几乎没有源码文件。"""

    return count_project_source_files(project_tree) <= max_source_files


def _basename(path: str) -> str:
    """返回路径最后一段（不区分目录/文件）。"""

    return path.rsplit("/", 1)[-1]


def _is_source(path: str) -> bool:
    """优先把源码/配置文件作为补全目标。"""

    lowered = path.lower()
    return any(lowered.endswith(ext) for ext in _SOURCE_EXTENSIONS)


def _expand_directory(
    target: str,
    project_paths: list[str],
    *,
    limit: int,
) -> list[str]:
    """把目录目标展开成目录内文件（深度优先、源码优先、封顶 limit）。"""

    prefix = target.rstrip("/")
    if not prefix:
        return []
    children = [
        path
        for path in project_paths
        if path.startswith(prefix + "/")
    ]
    if not children:
        return []
    children.sort(key=lambda item: (item.count("/"), not _is_source(item), item))
    return children[:limit]


def _match_path_token(
    token: str,
    project_paths: list[str],
) -> list[str]:
    """按文本中的路径 token 匹配项目文件。"""

    normalized = token.replace("\\", "/").lstrip("./").lower()
    if not normalized:
        return []
    matches: list[str] = []
    for path in project_paths:
        lowered = path.lower()
        if lowered == normalized or lowered.endswith("/" + normalized):
            matches.append(path)
        elif normalized.endswith("/" + _basename(lowered)) or lowered.endswith(normalized):
            matches.append(path)
    return matches


def _match_words(
    text: str,
    project_paths: list[str],
    *,
    limit: int,
) -> list[str]:
    """按任务文本中的 ASCII 词匹配文件名/路径片段，返回带分数的排序结果。"""

    words = {
        word.lower()
        for word in _ASCII_WORD.findall(text)
        if len(word) >= 3 and word.lower() not in {"the", "and", "for", "with"}
    }
    if not words:
        return []

    scored: list[tuple[int, str]] = []
    seen: set[str] = set()
    for path in project_paths:
        lowered = path.lower()
        name = _basename(lowered)
        name_without_ext = name.split(".", 1)[0]
        score = 0
        for word in words:
            if word == name or word == name_without_ext:
                score += 3
            elif word in name:
                score += 2
            elif any(word in segment for segment in lowered.split("/")):
                score += 1
        if score > 0 and path not in seen:
            seen.add(path)
            scored.append((score, path))
    scored.sort(key=lambda item: (-item[0], _basename(item[1]), item[1]))
    return [path for _score, path in scored[:limit]]


def probe_target_files(
    work: WorkItem,
    project_paths: list[str],
    *,
    limit: int = MAX_PREFLIGHT_FILES,
) -> list[str]:
    """确定性补全一个 Work 的 targetFiles。

    规则（只依赖路径/文本，不识别业务域）：
    1. 保留 Planner 声明的、确实存在的文件；
    2. 把声明为目录的条目展开成目录内文件；
    3. 仍然为空时，从标题/目标提取路径 token 与 ASCII 词匹配项目文件；
    4. 封顶 limit 个，避免单个 Work 过大。
    """

    project_set = {path.lower(): path for path in project_paths}
    result: list[str] = []
    seen: set[str] = set()

    declared = [
        path.strip().replace("\\", "/").lstrip("./")
        for path in work.target_files
        if path and path.strip()
    ]
    for target in declared:
        normalized = target.strip().rstrip("/")
        if not normalized:
            continue
        exact = project_set.get(normalized.lower())
        if exact:
            if exact not in seen:
                seen.add(exact)
                result.append(exact)
            continue
        children = _expand_directory(
            normalized,
            project_paths,
            limit=limit - len(result),
        )
        for child in children:
            if child not in seen:
                seen.add(child)
                result.append(child)
        if not children and normalized not in seen:
            # 可能是即将新建的文件，保留原声明。
            seen.add(normalized)
            result.append(normalized)
        if len(result) >= limit:
            return result[:limit]

    if result:
        return result[:limit]

    text = f"{work.title} {work.objective} {work.acceptance_criteria}"
    token_hits: list[str] = []
    for token in _PATH_TOKEN.findall(text):
        for path in _match_path_token(token, project_paths):
            if path not in token_hits:
                token_hits.append(path)
    if token_hits:
        return token_hits[:limit]

    return _match_words(text, project_paths, limit=limit)


def preflight_plan_works(
    works: list[WorkItem],
    project_tree: str,
) -> list[str]:
    """在派发前为全部 coding/agent Work 补全 targetFiles，返回调整说明。"""

    project_paths = extract_tree_paths(project_tree)
    if not project_paths:
        return []
    notes: list[str] = []
    for work in works:
        if work.execution_type not in {"coding", "agent"} or work.file_operations:
            continue
        before = list(work.target_files)
        filled = probe_target_files(work, project_paths)
        if not filled or filled == before:
            continue
        work.target_files = filled
        if not before:
            notes.append(f"{work.id} 预检补全 targetFiles {len(filled)} 个")
        elif len(filled) > len(before):
            notes.append(
                f"{work.id} 预检展开 targetFiles {len(before)}→{len(filled)}"
            )
    return notes


__all__ = [
    "MAX_PREFLIGHT_FILES",
    "count_project_source_files",
    "extract_tree_paths",
    "is_greenfield_project",
    "preflight_plan_works",
    "probe_target_files",
]
