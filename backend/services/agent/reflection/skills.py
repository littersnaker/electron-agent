"""技能更新审批通过后自动落盘（user 级 skill.yaml）。"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

import yaml

from backend.core.config import get_settings

LOGGER = logging.getLogger(__name__)

SKILL_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,79}$")
SAFE_NAME_PATTERN = re.compile(r"[^a-z0-9]+")


def _user_skill_root() -> Path:
    """user 级技能落盘目录（应用数据目录，可持久化）。"""

    return get_settings().data_dir / "skills" / "user"


def _project_skill_root() -> Path:
    """project 级技能目录（用于 patch 已存在的项目技能）。"""

    return Path(__file__).resolve().parents[4] / "skills" / "project"


def _to_skill_id(name: str) -> str:
    """把中文/带空格技能名转成合法的 skill id。"""

    value = SAFE_NAME_PATTERN.sub("-", (name or "").strip().lower())
    value = value.strip("-._")
    if not value:
        value = "review-skill"
    if not SKILL_ID_PATTERN.fullmatch(value):
        value = f"review-{value}"[:80]
    return value


def _find_skill_yaml(name_or_id: str) -> Path | None:
    """在 user / project 技能目录中按 id 或 name 查找 skill.yaml。"""

    identifier = _to_skill_id(name_or_id)
    for root in (_user_skill_root(), _project_skill_root()):
        if not root.is_dir():
            continue
        for path in sorted(root.rglob("skill.yaml")):
            try:
                raw = yaml.safe_load(path.read_text("utf-8"))
            except (OSError, yaml.YAMLError):
                continue
            if not isinstance(raw, dict):
                continue
            raw_id = str(raw.get("id") or raw.get("name") or "").strip().lower()
            raw_name = str(raw.get("name") or "").strip().lower()
            if raw_id == identifier or raw_name == identifier or raw_name == name_or_id.strip().lower():
                return path
    return None


def _write_skill_yaml(
    path: Path,
    *,
    skill_id: str,
    name: str,
    description: str,
    prompt: str,
) -> Path:
    """写一份最小合法的 user 级 skill.yaml。"""

    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "id": skill_id,
        "name": (name or skill_id).strip()[:80],
        "version": "1.0.0",
        "description": (description or "复盘循环沉淀的技能").strip()[:300],
        "scope": "user",
        "prompt": prompt.strip(),
        "tools": [],
        "memory": [],
        "permissions": {},
        "requires_reasoning": False,
        "tags": ["review-generated"],
    }
    path.write_text(
        yaml.safe_dump(payload, allow_unicode=True, sort_keys=False),
        encoding="utf-8",
    )
    return path


def create_skill_from_review(
    *,
    name: str,
    diff_summary: str,
    evidence: str,
) -> dict[str, Any]:
    """create：在 user 技能目录新建技能。"""

    skill_id = _to_skill_id(name)
    root = _user_skill_root()
    path = root / skill_id / "skill.yaml"
    if path.exists():
        return {"name": name, "action": "create", "status": "exists", "path": str(path)}
    prompt = (
        f"# {name}\n\n"
        f"## 来源\n复盘循环自动沉淀（evidence: {evidence or 'review'}）\n\n"
        f"## 操作流程\n{diff_summary.strip()}"
    )
    _write_skill_yaml(
        path,
        skill_id=skill_id,
        name=name,
        description=diff_summary.strip()[:200],
        prompt=prompt,
    )
    LOGGER.info("复盘技能已创建：%s", path)
    return {"name": name, "action": "create", "status": "created", "path": str(path)}


def patch_skill_from_review(
    *,
    name: str,
    diff_summary: str,
    evidence: str,
) -> dict[str, Any]:
    """patch：追加一段复盘补充到已有技能；不存在则退化为创建。"""

    skill_path = _find_skill_yaml(name)
    if skill_path is None:
        result = create_skill_from_review(name=name, diff_summary=diff_summary, evidence=evidence)
        result["action"] = "patch->create"
        return result
    try:
        raw = yaml.safe_load(skill_path.read_text("utf-8"))
        prompt_file = skill_path.parent / "prompt.md"
        addition = (
            "\n\n## 复盘补充（自动）\n"
            f"{diff_summary.strip()}\n"
            f"（evidence: {evidence or 'review'}）"
        )
        if prompt_file.is_file():
            prompt_file.write_text(
                prompt_file.read_text("utf-8").rstrip() + addition + "\n",
                encoding="utf-8",
            )
        elif isinstance(raw, dict):
            current_prompt = str(raw.get("prompt") or "")
            raw["prompt"] = current_prompt.rstrip() + addition
            skill_path.write_text(
                yaml.safe_dump(raw, allow_unicode=True, sort_keys=False),
                encoding="utf-8",
            )
        else:
            return {"name": name, "action": "patch", "status": "skipped", "path": str(skill_path)}
    except (OSError, yaml.YAMLError) as exc:
        LOGGER.warning("技能 patch 失败 %s：%s", skill_path, exc)
        return {"name": name, "action": "patch", "status": "error", "path": str(skill_path)}
    LOGGER.info("复盘技能已更新：%s", skill_path)
    return {"name": name, "action": "patch", "status": "patched", "path": str(skill_path)}


def apply_skill_updates(skill_updates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """审批通过后应用技能更新，返回每条的落盘结果。"""

    results: list[dict[str, Any]] = []
    for update in skill_updates:
        if not isinstance(update, dict):
            continue
        action = str(update.get("action") or "create")
        name = str(update.get("name") or "").strip()
        diff_summary = str(update.get("diff_summary") or "").strip()
        evidence = str(update.get("evidence") or "")
        if not name or not diff_summary:
            results.append(
                {"name": name or "unknown", "action": action, "status": "skipped"}
            )
            continue
        if action == "patch":
            results.append(
                patch_skill_from_review(
                    name=name,
                    diff_summary=diff_summary,
                    evidence=evidence,
                )
            )
        else:
            results.append(
                create_skill_from_review(
                    name=name,
                    diff_summary=diff_summary,
                    evidence=evidence,
                )
            )
    return results
