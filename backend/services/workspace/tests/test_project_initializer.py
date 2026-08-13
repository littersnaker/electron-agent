"""创建项目初始化选项测试（git init / README / 前端骨架）。"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from backend.services.workspace.project_initializer import initialize_project


@pytest.fixture()
def project_dir(tmp_path: Path) -> Path:
    """返回一个已存在但为空的目录。"""

    target = tmp_path / "my-app"
    target.mkdir()
    return target


@pytest.mark.asyncio
async def test_initialize_readme_and_skeleton(project_dir: Path) -> None:
    """README 与前端骨架应生成且不覆盖已存在文件。"""

    warnings = await initialize_project(project_dir, ["readme", "skeleton"])

    assert warnings == []
    readme = project_dir / "README.md"
    assert readme.is_file()
    assert "my-app" in readme.read_text("utf-8")
    package = json.loads((project_dir / "package.json").read_text("utf-8"))
    assert package["name"] == "my-app"
    assert (project_dir / "src" / "main.tsx").is_file()
    assert (project_dir / "index.html").is_file()
    assert (project_dir / ".gitignore").is_file()


@pytest.mark.asyncio
async def test_initialize_skips_existing_files(project_dir: Path) -> None:
    """已存在的文件不应被覆盖。"""

    (project_dir / "README.md").write_text("existing", encoding="utf-8")
    warnings = await initialize_project(project_dir, ["readme"])

    assert warnings == []
    assert (project_dir / "README.md").read_text("utf-8") == "existing"


@pytest.mark.asyncio
async def test_initialize_git(project_dir: Path) -> None:
    """git init 应在目录内创建 .git。"""

    git_available = shutil.which("git")
    if not git_available:
        pytest.skip("环境中没有 git")

    warnings = await initialize_project(project_dir, ["git"])

    assert (project_dir / ".git").is_dir()
    # git 可用时应无警告。
    assert warnings == []


@pytest.mark.asyncio
async def test_initialize_empty_options_noop(project_dir: Path) -> None:
    """没有勾选任何选项时不应写任何文件。"""

    warnings = await initialize_project(project_dir, [])

    assert warnings == []
    assert not (project_dir / "README.md").exists()
    assert not (project_dir / "package.json").exists()
