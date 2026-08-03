"""Skill 加载、优先级和安全路径测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from backend.skills.loader import SkillLoader
from backend.skills.registry import SkillRegistry


def _write_skill(root: Path, folder: str, *, version: str, prompt: str) -> None:
    """在测试目录创建一个最小合法 Skill。"""

    skill_root = root / folder
    skill_root.mkdir(parents=True)
    (skill_root / "skill.yaml").write_text(
        "\n".join(
            (
                "id: sample-skill",
                "name: Sample Skill",
                f"version: {version}",
                "prompt:",
                "  file: prompt.md",
                "tools: []",
                "memory: []",
                "permissions: {}",
            )
        ),
        "utf-8",
    )
    (skill_root / "prompt.md").write_text(prompt, "utf-8")


def test_skill_registry_prefers_scope_then_highest_version(tmp_path: Path) -> None:
    """System Scope 应优先于 User，同一 Scope 应选择更高版本。"""

    system = tmp_path / "system"
    user = tmp_path / "user"
    _write_skill(system, "v1", version="1.9.0", prompt="system old")
    _write_skill(system, "v2", version="1.10.0", prompt="system new")
    _write_skill(user, "v9", version="9.0.0", prompt="user newest")

    registry = SkillRegistry({"system": (system,), "user": (user,)})
    registry.load()

    resolved = registry.resolve(("sample-skill",))[0]
    assert resolved.scope == "system"
    assert resolved.version == "1.10.0"
    assert resolved.prompt == "system new"


def test_skill_loader_rejects_prompt_outside_skill_directory(tmp_path: Path) -> None:
    """Skill Prompt 不得通过相对路径读取目录外文件。"""

    skill_root = tmp_path / "skill"
    skill_root.mkdir()
    (tmp_path / "secret.md").write_text("secret", "utf-8")
    config = skill_root / "skill.yaml"
    config.write_text(
        "\n".join(
            (
                "id: safe-skill",
                "version: 1.0.0",
                "prompt:",
                "  file: ../secret.md",
                "permissions: {}",
            )
        ),
        "utf-8",
    )

    with pytest.raises(ValueError, match="越出目录"):
        SkillLoader().load(config, scope="system")


def test_skill_registry_matches_task_tags(tmp_path: Path) -> None:
    """动态 Skill 只能按任务标签命中少量相关能力。"""

    root = tmp_path / "system"
    skill_root = root / "apple-ui"
    skill_root.mkdir(parents=True)
    (skill_root / "skill.yaml").write_text(
        "\n".join(
            (
                "id: apple-miniapp-ui",
                "name: Apple UI",
                "version: 1.0.0",
                "prompt:",
                "  file: prompt.md",
                "tags:",
                "  - 小程序",
                "  - UI",
                "permissions: {}",
            )
        ),
        "utf-8",
    )
    (skill_root / "prompt.md").write_text("使用 Apple 风格组件。", "utf-8")
    registry = SkillRegistry({"system": (root,)})
    registry.load()

    matched = registry.match("完善小程序 UI", limit=1)

    assert [item.id for item in matched] == ["apple-miniapp-ui"]
