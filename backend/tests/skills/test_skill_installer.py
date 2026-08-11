"""外部 Skill 安装器：转换、校验、安装、恢复、卸载与安全路径测试。"""

from __future__ import annotations

import io
import tarfile
from pathlib import Path

import pytest

from backend.core.config import get_settings
from backend.services.skills import installer
from backend.services.workspace.database import initialize_database

SAMPLE_SKILL_MD = """---
name: Order Review Assistant
description: Helps review e-commerce orders for anomalies.
version: 1.2.0
tags: [commerce, review]
---

# Order Review Assistant

Follow these steps when reviewing orders:
1. Check payment status first.
2. Flag orders with duplicate request ids.
"""

SAMPLE_SKILL_YAML = """id: listing-writer
name: Listing Writer
version: 0.3.1
description: Generates Amazon listings.
prompt: |
  使用结构化流程生成 Listing，必须包含五点描述。
tools: []
memory: []
permissions: {}
"""


@pytest.fixture()
def isolated_installer(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """把数据目录隔离到临时目录，并重置 settings 缓存。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    try:
        # 初始化包含 installed_skills 表的数据库。
        import asyncio

        asyncio.run(initialize_database())
        yield
    finally:
        get_settings.cache_clear()


def test_convert_skill_md_frontmatter() -> None:
    """SKILL.md 应正确拆出 frontmatter 字段与正文。"""

    converted = installer._convert_raw_content(SAMPLE_SKILL_MD, "https://x/SKILL.md")
    assert converted["sourceFormat"] == "skill-md"
    assert converted["name"] == "Order Review Assistant"
    assert converted["version"] == "1.2.0"
    assert "Check payment status first" in converted["promptText"]
    assert converted["tags"] == ["commerce", "review"]


def test_convert_skill_yaml_inline_prompt() -> None:
    """内部 skill.yaml 内联 prompt 应被接受。"""

    converted = installer._convert_raw_content(
        SAMPLE_SKILL_YAML,
        "https://x/skill.yaml",
    )
    assert converted["sourceFormat"] == "skill-yaml"
    assert converted["name"] == "Listing Writer"
    assert "五点描述" in converted["promptText"]


def test_convert_rejects_file_prompt() -> None:
    """引用外部文件的 skill.yaml 应被拒绝（v1 仅支持内联）。"""

    raw = """id: listing-writer
name: Listing Writer
version: 0.3.1
description: Generates Amazon listings.
prompt: prompt.md
tools: []
memory: []
permissions: {}
"""
    with pytest.raises(ValueError, match="仅支持内联"):
        installer._convert_raw_content(raw, "https://x/skill.yaml")


def test_convert_rejects_unknown_format() -> None:
    """无法识别的格式应报错。"""

    with pytest.raises(ValueError, match="无法识别"):
        installer._convert_raw_content("a: [unclosed", "https://x/file.txt")
    with pytest.raises(ValueError, match="必须是对象"):
        installer._convert_raw_content("hello world", "https://x/file.txt")


def test_build_skill_yaml_is_valid() -> None:
    """生成的 skill.yaml 应通过校验并强制 user scope。"""

    converted = installer._convert_raw_content(SAMPLE_SKILL_MD, "https://x/SKILL.md")
    skill_yaml, prompt_text = installer._build_skill_yaml(converted)
    assert skill_yaml["id"] == "order-review-assistant"
    assert skill_yaml["scope"] == "user"
    assert skill_yaml["prompt"] == "prompt.md"
    assert prompt_text.startswith("# Order Review Assistant")


def test_skill_dir_rejects_traversal(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """路径穿越应被拒绝，卸载/导出不能越出 user 目录。"""

    monkeypatch.setattr(installer, "_user_skill_root", lambda: tmp_path / "user")
    with pytest.raises(ValueError, match="非法"):
        installer._skill_dir("../evil")


@pytest.mark.asyncio
async def test_install_restore_uninstall_flow(
    isolated_installer: None,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """完整流程：安装 → 落盘 + 入库 → 删文件后恢复 → 卸载清理。"""

    async def fake_download(url: str) -> str:
        assert url == "https://example.com/SKILL.md"
        return SAMPLE_SKILL_MD

    monkeypatch.setattr(installer, "_download_text", fake_download)

    installed = await installer.install_skill_from_url("https://example.com/SKILL.md")
    assert installed["id"] == "order-review-assistant"

    skill_root = installer._user_skill_root() / "order-review-assistant"
    assert (skill_root / "skill.yaml").is_file()
    assert (skill_root / "prompt.md").is_file()

    listed = await installer.list_installed_skills()
    assert len(listed) == 1
    assert listed[0]["filesExist"] is True
    assert listed[0]["sourceUrl"] == "https://example.com/SKILL.md"

    # 模拟文件丢失：删除 skill 目录后应从 SQLite 恢复。
    import shutil

    shutil.rmtree(skill_root)
    restored = await installer.restore_installed_skills()
    assert restored == 1
    assert (skill_root / "skill.yaml").is_file()
    assert (skill_root / "prompt.md").is_file()

    removed = await installer.uninstall_skill("order-review-assistant")
    assert removed["id"] == "order-review-assistant"
    assert not skill_root.exists()
    assert await installer.list_installed_skills() == []


@pytest.mark.asyncio
async def test_install_rejects_non_http(isolated_installer: None) -> None:
    """非 http/https 来源应被拒绝，且不会触碰文件系统。"""

    with pytest.raises(ValueError, match="只支持 http/https"):
        await installer.install_skill_from_url("file:///etc/passwd")


@pytest.mark.asyncio
async def test_uninstall_unknown_skill(isolated_installer: None) -> None:
    """卸载未安装的 Skill 应报 KeyError。"""

    with pytest.raises(KeyError, match="未安装"):
        await installer.uninstall_skill("never-installed")


def _make_tarball(files: dict[str, str | bytes], root: str = "repo-main") -> bytes:
    """构造内存 tar.gz，模拟 GitHub 仓库压缩包结构。"""

    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for relative, content in files.items():
            data = content.encode("utf-8") if isinstance(content, str) else content
            info = tarfile.TarInfo(f"{root}/{relative}")
            info.size = len(data)
            archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


@pytest.mark.parametrize(
    ("source", "expected"),
    [
        ("owner/repo", ("owner", "repo", "", "")),
        ("owner/repo/path/to/skill", ("owner", "repo", "", "path/to/skill")),
        ("owner/repo@main", ("owner", "repo", "main", "")),
        ("owner/repo@dev/path", ("owner", "repo", "dev", "path")),
        ("https://github.com/owner/repo", ("owner", "repo", "", "")),
        (
            "https://github.com/owner/repo/tree/main/skills/foo",
            ("owner", "repo", "main", "skills/foo"),
        ),
        (
            "https://github.com/owner/repo/blob/main/skills/foo/SKILL.md",
            ("owner", "repo", "main", "skills/foo"),
        ),
    ],
)
def test_parse_github_spec(source: str, expected: tuple[str, str, str, str]) -> None:
    """GitHub 安装标识应正确解析出 owner/repo/ref/subpath。"""

    assert installer._parse_github_spec(source) == expected


def test_parse_github_spec_rejects_invalid() -> None:
    """缺少 owner/repo 或含 .. 的路径应报错。"""

    with pytest.raises(ValueError, match="owner/repo"):
        installer._parse_github_spec("only-owner")
    with pytest.raises(ValueError, match=r"不能包含 \.\."):
        installer._parse_github_spec("owner/repo/../evil")


def test_extract_skill_files_with_attachments() -> None:
    """应定位 SKILL.md 并收集 references/scripts 等附加文件。"""

    tarball = _make_tarball(
        {
            "skills/order-triage/SKILL.md": SAMPLE_SKILL_MD,
            "skills/order-triage/references/checklist.md": "# Checklist\n1. Verify HMAC\n",
            "skills/order-triage/scripts/run.sh": "#!/bin/sh\necho triage\n",
            "README.md": "repo readme",
        }
    )
    skill_text, extra_files = installer._extract_skill_files(
        tarball,
        "skills/order-triage",
    )
    assert "Order Review Assistant" in skill_text
    assert set(extra_files) == {
        "references/checklist.md",
        "scripts/run.sh",
    }


def test_extract_skill_files_missing_skill_md() -> None:
    """指定位置没有 SKILL.md 时应报错并提示候选目录。"""

    tarball = _make_tarball(
        {
            "skills/order-triage/prompt.md": "no frontmatter here",
            "skills/other/SKILL.md": SAMPLE_SKILL_MD,
        }
    )
    with pytest.raises(ValueError, match="SKILL.md"):
        installer._extract_skill_files(tarball, "skills/order-triage")


def test_encode_decode_extra_files_roundtrip() -> None:
    """文本与二进制附加文件应可无损往返。"""

    source = {
        "references/note.md": "中文文本".encode("utf-8"),
        "assets/icon.png": b"\x89PNG\r\n\x1a\nbinary",
    }
    encoded = installer._encode_extra_files(source)
    assert encoded["references/note.md"]["encoding"] == "utf-8"
    assert encoded["assets/icon.png"]["encoding"] == "base64"
    decoded = installer._decode_extra_files(encoded)
    assert decoded["references/note.md"] == "中文文本".encode("utf-8")
    assert decoded["assets/icon.png"] == b"\x89PNG\r\n\x1a\nbinary"


@pytest.mark.asyncio
async def test_install_from_github_full_flow(
    isolated_installer: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """GitHub 全流程：tarball 安装 → 附加文件落盘 → 删文件恢复 → 卸载。"""

    tarball = _make_tarball(
        {
            "skills/order-triage/SKILL.md": SAMPLE_SKILL_MD,
            "skills/order-triage/references/checklist.md": "# Checklist\n1. Verify HMAC\n",
            "skills/order-triage/scripts/run.sh": "#!/bin/sh\necho triage\n",
        }
    )

    async def fake_tarball(owner: str, repo: str, ref: str) -> bytes:
        assert (owner, repo, ref) == ("acme", "skills", "")
        return tarball

    monkeypatch.setattr(installer, "_download_github_tarball", fake_tarball)

    installed = await installer.install_skill_from_github(
        "acme/skills/skills/order-triage"
    )
    assert installed["id"] == "order-review-assistant"
    assert installed["extraFileCount"] == 2

    skill_root = installer._user_skill_root() / "order-review-assistant"
    assert (skill_root / "references" / "checklist.md").is_file()
    assert (skill_root / "scripts" / "run.sh").is_file()
    assert (skill_root / "references" / "checklist.md").read_text(
        "utf-8"
    ).startswith("# Checklist")

    # 删除整个目录后应从 SQLite 恢复主文件与附加文件。
    import shutil

    shutil.rmtree(skill_root)
    restored = await installer.restore_installed_skills()
    assert restored == 1
    assert (skill_root / "skill.yaml").is_file()
    assert (skill_root / "references" / "checklist.md").is_file()
    assert (skill_root / "scripts" / "run.sh").is_file()

    await installer.uninstall_skill("order-review-assistant")
    assert not skill_root.exists()


@pytest.mark.asyncio
async def test_install_skill_unified_entry(
    isolated_installer: None,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """统一入口应正确分流 GitHub 标识与 http 直链。"""

    tarball = _make_tarball({"SKILL.md": SAMPLE_SKILL_MD})

    async def fake_tarball(owner: str, repo: str, ref: str) -> bytes:
        return tarball

    async def fake_text(url: str) -> str:
        return SAMPLE_SKILL_MD

    monkeypatch.setattr(installer, "_download_github_tarball", fake_tarball)
    monkeypatch.setattr(installer, "_download_text", fake_text)

    from_github = await installer.install_skill("acme/skills")
    assert from_github["id"] == "order-review-assistant"
    await installer.uninstall_skill("order-review-assistant")

    from_url = await installer.install_skill("https://example.com/SKILL.md")
    assert from_url["id"] == "order-review-assistant"
    await installer.uninstall_skill("order-review-assistant")

    with pytest.raises(ValueError, match="无法识别"):
        await installer.install_skill("not-a-source")
