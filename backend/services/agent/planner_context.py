"""Planner 输入裁剪适配器。"""

from __future__ import annotations

import re

from backend.services.agent.planner_input import PlannerInputBuilder

_FILE_HEADER = re.compile(r"^--- FILE:\s*(.+?)\s*---$", re.MULTILINE)
_SKILL_HEADER = re.compile(r"^## Skill · ([^@\n]+)@[^\n]+$", re.MULTILINE)
_MEMORY_HEADER = re.compile(r"^## Memory · ([^\n]+)$", re.MULTILINE)


def build_planner_prompt(
    *,
    user_request: str,
    project_tree: str,
    initial_context: str,
) -> str:
    """把检索上下文解析为相关文件并交由 PlannerInputBuilder 限量格式化。"""

    matches = list(_FILE_HEADER.finditer(initial_context))
    paths: list[str] = []
    contents: dict[str, str] = {}
    for index, match in enumerate(matches[:100]):
        path = match.group(1).strip().replace("\\", "/")
        end = matches[index + 1].start() if index + 1 < len(matches) else len(initial_context)
        paths.append(path)
        contents[path] = initial_context[match.end() : end].strip()
    skill_matches = list(_SKILL_HEADER.finditer(initial_context))
    skill_directives: list[str] = []
    for index, match in enumerate(skill_matches[:6]):
        end = (
            skill_matches[index + 1].start()
            if index + 1 < len(skill_matches)
            else len(initial_context)
        )
        block = initial_context[match.end() : end]
        next_heading = re.search(r"^## (?!Skill · ).+$", block, re.MULTILINE)
        if next_heading:
            block = block[: next_heading.start()]
        compact = " ".join(block.split())[:800]
        if compact:
            skill_directives.append(f"- {match.group(1).strip()}: {compact}")

    memory_matches = list(_MEMORY_HEADER.finditer(initial_context))
    memory_notes: list[str] = []
    for index, match in enumerate(memory_matches[:8]):
        end = (
            memory_matches[index + 1].start()
            if index + 1 < len(memory_matches)
            else len(initial_context)
        )
        block = initial_context[match.end() : end]
        next_heading = re.search(
            r"^(?:## (?!Memory · ).+|--- FILE:.*)$",
            block,
            re.MULTILINE,
        )
        if next_heading:
            block = block[: next_heading.start()]
        compact = " ".join(block.split())[:1_200]
        if compact:
            memory_notes.append(f"- {match.group(1).strip()}: {compact}")

    planner_input = PlannerInputBuilder().build(
        user_goal=user_request,
        project_tree=project_tree,
        relevant_file_paths=paths,
        file_contents=contents,
        memory_notes=memory_notes,
        skill_directives=skill_directives,
    )
    return planner_input.to_prompt()


__all__ = ["build_planner_prompt"]
