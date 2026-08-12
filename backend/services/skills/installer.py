"""外部 Skill 安装器：下载 → 转换 → 校验 → SQLite 持久化 → 导出文件系统。

安装流：从 URL 拉取外部生态标准的 ``SKILL.md``（或内部 ``skill.yaml``），
转换成应用内部的 ``skill.yaml + prompt.md``，写入 SQLite 作为持久化仓库，
同时导出到 user 级 Skill 目录供 Runtime 扫描加载。卸载时反向清理。

SQLite 是安装记录的唯一事实来源；启动时调用
:func:`restore_installed_skills` 可以把误删/损坏的 Skill 文件重建回来。
"""

from __future__ import annotations

import base64
import io
import logging
import re
import shutil
import tarfile
from pathlib import Path
from typing import Any

import httpx
import yaml

from backend.core.config import get_settings
from backend.services.skills.validator import SKILL_ID_PATTERN, SkillValidator
from backend.services.workspace.database import (
    dumps_json,
    loads_json,
    open_database,
    utc_now_iso,
)

LOGGER = logging.getLogger(__name__)

MAX_SKILL_BYTES = 5 * 1024 * 1024  # 5MB
MAX_TARBALL_BYTES = 64 * 1024 * 1024  # 64MB（仓库压缩包上限）
MAX_EXTRA_FILES = 100
MAX_EXTRA_FILE_BYTES = 2 * 1024 * 1024  # 单附加文件 2MB
MAX_EXTRA_TOTAL_BYTES = 10 * 1024 * 1024  # 附加文件总量 10MB
DOWNLOAD_TIMEOUT_SECONDS = 30.0
SAFE_NAME_PATTERN = re.compile(r"[^a-z0-9]+")
GITHUB_REPO_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")

ALLOWED_SCHEMES = {"http", "https"}
DEFAULT_VERSION = "0.0.0"

_AGENT_KEYWORDS: dict[str, tuple[str, ...]] = {
    "coding": (
        "react", "vue", "taro", "css", "html", "javascript", "typescript",
        "gsap", "frontend", "前端", "小程序", "组件", "component", "动画",
        "animation", "web",
    ),
    "commerce": (
        "amazon", "listing", "marketplace", "ecommerce", "电商", "运营",
        "广告", "listing", "关键词",
    ),
    "media": (
        "comic", "storyboard", "漫剧", "视频生成", "图片生成", "图片编辑",
        "视频编辑", "media", "图像",
    ),
    "qa": (
        "问答", "知识库", "文档", "knowledge", "qa", "faq",
    ),
}

_TEXT_SUFFIXES = {
    ".md", ".markdown", ".yaml", ".yml", ".json", ".txt", ".py", ".ts", ".tsx",
    ".js", ".jsx", ".sh", ".bash", ".ps1", ".sql", ".html", ".css", ".toml",
    ".ini", ".cfg", ".env", ".csv", ".xml", ".svg",
}

_SKIP_DIR_PARTS = {
    "__pycache__",
    ".git",
    ".svn",
    ".hg",
    "node_modules",
    ".venv",
    "venv",
    ".next",
    "dist",
    "build",
}


def _user_skill_root() -> Path:
    """user 级 Skill 落盘目录（应用数据目录，可持久化）。"""

    return get_settings().data_dir / "skills" / "user"


def _to_skill_id(name: str) -> str:
    """把中文/带空格的外部 Skill 名转成合法的 skill id。"""

    value = SAFE_NAME_PATTERN.sub("-", (name or "").strip().lower())
    value = value.strip("-._")
    if not value:
        value = "external-skill"
    if not SKILL_ID_PATTERN.fullmatch(value):
        value = f"skill-{value}"[:80]
    return value


def _url_slug_fallback(url: str) -> str | None:
    """从 URL 最后一段推断 Skill 名（frontmatter 缺 name 时兜底）。"""

    tail = (url or "").rstrip("/").split("/")[-1].strip()
    if not tail or tail in {"SKILL.md", "skill.md", "skill.yaml"}:
        return None
    name = re.sub(r"\.(md|yaml|yml)$", "", tail, flags=re.IGNORECASE)
    return re.sub(r"[-_]+", " ", name).strip() or None


def _recommend_agents(
    *,
    name: str,
    description: str,
    tags: tuple[str, ...],
) -> list[str]:
    """根据 Skill 内容关键词推荐绑定的 Agent（无强信号时返回空列表）。"""

    haystack = " ".join([name, description, *tags]).lower()
    recommended: list[str] = []
    for agent_id, keywords in _AGENT_KEYWORDS.items():
        if any(keyword in haystack for keyword in keywords):
            recommended.append(agent_id)
    return recommended


def _parse_github_spec(source: str) -> tuple[str, str, str, str]:
    """解析 GitHub 安装标识为 (owner, repo, ref, subpath)。

    支持：
    - ``owner/repo``
    - ``owner/repo/path/to/skill``
    - ``owner/repo@branch`` / ``owner/repo@branch/path``
    - ``https://github.com/owner/repo``
    - ``https://github.com/owner/repo/tree/branch/path``
    - ``https://github.com/owner/repo/blob/branch/path/SKILL.md``
    """

    value = (source or "").strip().rstrip("/")
    if not value:
        raise ValueError("GitHub 安装地址为空")

    subpath = ""
    ref = ""
    if value.startswith("https://github.com/"):
        rest = value[len("https://github.com/") :]
        segments = [item for item in rest.split("/") if item]
        if len(segments) < 2:
            raise ValueError("GitHub 链接缺少 owner/repo")
        owner, repo = segments[0], segments[1]
        if len(segments) > 2:
            kind = segments[2]
            if kind in {"tree", "blob"}:
                # tree/branch/path 或 tree/{ref}/path；blob 时去掉末尾文件名。
                remaining = segments[3:]
                if remaining:
                    ref = remaining[0]
                    subpath = "/".join(remaining[1:])
                    if kind == "blob":
                        subpath = "/".join(subpath.split("/")[:-1])
            else:
                subpath = "/".join(segments[2:])
    else:
        owner_repo_part, separator, tail = value.partition("@")
        if separator:
            ref, _, subpath = tail.partition("/")
            subpath = subpath.strip("/")
        elif "/" in value:
            parts = value.split("/", 2)
            owner_repo_part = f"{parts[0]}/{parts[1]}"
            subpath = parts[2] if len(parts) > 2 else ""
        else:
            raise ValueError("GitHub 安装地址需要 owner/repo 格式")
        owner, repo = owner_repo_part.split("/", 1)

    if not GITHUB_REPO_PATTERN.fullmatch(f"{owner}/{repo}"):
        raise ValueError(f"GitHub 仓库名不合法：{owner}/{repo}")
    repo = repo.removesuffix(".git")
    subpath = subpath.strip("/")
    if ".." in subpath.split("/"):
        raise ValueError("GitHub Skill 路径不能包含 ..")
    return owner, repo, ref.strip("/"), subpath


async def _download_text(url: str) -> str:
    """下载外部 Skill 文本，限制协议、大小和超时。"""

    scheme = url.split(":", 1)[0].lower() if ":" in url else ""
    if scheme not in ALLOWED_SCHEMES:
        raise ValueError("Skill 安装地址只支持 http/https")
    if len(url) > 2048:
        raise ValueError("Skill 安装地址过长")

    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=DOWNLOAD_TIMEOUT_SECONDS,
    ) as client:
        response = await client.get(url)
        response.raise_for_status()

    content = response.content
    if len(content) > MAX_SKILL_BYTES:
        raise ValueError(f"Skill 文件超过 {MAX_SKILL_BYTES // (1024 * 1024)}MB 上限")
    text = content.decode("utf-8", errors="replace")
    if not text.strip():
        raise ValueError("下载的 Skill 内容为空")
    return text


async def _download_github_tarball(owner: str, repo: str, ref: str) -> bytes:
    """下载 GitHub 仓库 tarball，限制大小与超时。"""

    ref_part = ref or "HEAD"
    url = f"https://codeload.github.com/{owner}/{repo}/tar.gz/{ref_part}"
    async with httpx.AsyncClient(
        follow_redirects=True,
        timeout=DOWNLOAD_TIMEOUT_SECONDS,
    ) as client:
        response = await client.get(url)
        response.raise_for_status()
    content = response.content
    if len(content) > MAX_TARBALL_BYTES:
        raise ValueError(
            f"仓库压缩包超过 {MAX_TARBALL_BYTES // (1024 * 1024)}MB 上限"
        )
    if len(content) < 2:
        raise ValueError("下载的仓库压缩包为空")
    return content


def _extract_skill_files(
    tarball_bytes: bytes,
    subpath: str,
) -> tuple[str, dict[str, bytes]]:
    """从 tarball 中定位 Skill 目录，返回 (SKILL.md 文本, 附加文件表)。"""

    try:
        archive = tarfile.open(fileobj=io.BytesIO(tarball_bytes), mode="r:gz")
    except tarfile.TarError as exc:
        raise ValueError(f"仓库压缩包解析失败：{exc}") from exc

    with archive:
        members = [member for member in archive.getmembers() if member.isfile()]
        if not members:
            raise ValueError("仓库压缩包中没有文件")
        root_name = members[0].name.split("/", 1)[0]

        # 先找 SKILL.md，确定 skill 目录前缀（保留大小写变体）。
        skill_prefix: str | None = None
        skill_member_name: str | None = None
        subpath_base = subpath.rstrip("/")
        for member in members:
            full_relative = (
                member.name[len(root_name) + 1 :]
                if member.name.startswith(root_name)
                else member.name
            )
            if subpath:
                if not (
                    full_relative == subpath_base
                    or full_relative.startswith(subpath_base + "/")
                ):
                    continue
            elif "/" in full_relative:
                continue
            if full_relative.lower().endswith("skill.md"):
                skill_member_name = member.name
                break

        if skill_member_name is not None:
            skill_prefix = skill_member_name.rsplit("/", 1)[0]

        if skill_member_name is None:
            candidates = sorted(
                {
                    member.name.rsplit("/", 1)[0]
                    for member in members
                    if member.name.lower().endswith("/skill.md")
                }
            )[:5]
            hint = "；仓库中含 SKILL.md 的目录：" + "、".join(candidates) if candidates else ""
            raise ValueError(
                f"未在指定位置找到 SKILL.md{hint}，请使用 owner/repo/路径 指定 Skill 目录"
            )

        skill_text = ""
        extra_files: dict[str, bytes] = {}
        total_size = 0
        for member in members:
            if not member.name.startswith(skill_prefix + "/") or member.name == skill_member_name:
                continue
            relative = member.name[len(skill_prefix) + 1 :]
            parts = relative.split("/")
            if any(part in _SKIP_DIR_PARTS for part in parts[:-1]):
                continue
            if member.size > MAX_EXTRA_FILE_BYTES:
                raise ValueError(f"附加文件超过 2MB：{relative}")
            total_size += member.size
            if total_size > MAX_EXTRA_TOTAL_BYTES:
                raise ValueError("Skill 附加文件总量超过 10MB 上限")
            if len(extra_files) >= MAX_EXTRA_FILES:
                raise ValueError("Skill 附加文件数量超过 100 个上限")
            extracted = archive.extractfile(member)
            if extracted is None:
                continue
            extra_files[relative] = extracted.read()

        if not skill_text:
            skill_member = archive.getmember(skill_member_name)
            extracted = archive.extractfile(skill_member)
            if extracted is None:
                raise ValueError("无法读取 SKILL.md")
            skill_text = extracted.read().decode("utf-8", errors="replace")

    return skill_text, extra_files


def _find_skill_directories(tarball_bytes: bytes) -> list[str]:
    """扫描 tarball 中所有含 SKILL.md 的目录（相对仓库根路径，排序去重）。"""

    try:
        archive = tarfile.open(fileobj=io.BytesIO(tarball_bytes), mode="r:gz")
    except tarfile.TarError as exc:
        raise ValueError(f"仓库压缩包解析失败：{exc}") from exc

    with archive:
        members = [member for member in archive.getmembers() if member.isfile()]
        if not members:
            raise ValueError("仓库压缩包中没有文件")
        root_name = members[0].name.split("/", 1)[0]
        directories: set[str] = set()
        for member in members:
            full_relative = (
                member.name[len(root_name) + 1 :]
                if member.name.startswith(root_name)
                else member.name
            )
            if full_relative.lower().endswith("skill.md"):
                parent = full_relative.rsplit("/", 1)[0]
                if parent:
                    directories.add(parent)
    return sorted(directories)


def _encode_extra_files(extra_files: dict[str, bytes]) -> dict[str, dict[str, str]]:
    """把附加文件编码为可存 SQLite 的 JSON 结构。"""

    encoded: dict[str, dict[str, str]] = {}
    for relative, content in sorted(extra_files.items()):
        suffix = Path(relative).suffix.lower()
        if suffix in _TEXT_SUFFIXES:
            try:
                text = content.decode("utf-8")
            except UnicodeDecodeError:
                text = ""
            if text:
                encoded[relative] = {"encoding": "utf-8", "content": text}
                continue
        encoded[relative] = {
            "encoding": "base64",
            "content": base64.b64encode(content).decode("ascii"),
        }
    return encoded


def _decode_extra_files(encoded: dict[str, Any]) -> dict[str, bytes]:
    """把 SQLite 中的附加文件还原为字节内容。"""

    decoded: dict[str, bytes] = {}
    if not isinstance(encoded, dict):
        return decoded
    for relative, item in encoded.items():
        if not isinstance(item, dict):
            continue
        encoding = str(item.get("encoding") or "base64")
        content = str(item.get("content") or "")
        if encoding == "utf-8":
            decoded[str(relative)] = content.encode("utf-8")
        else:
            try:
                decoded[str(relative)] = base64.b64decode(content)
            except (ValueError, TypeError):
                continue
    return decoded


def _parse_frontmatter(content: str) -> tuple[dict[str, Any], str]:
    """解析 ``--- yaml ---`` frontmatter 与正文。"""

    if not content.startswith("---"):
        raise ValueError("SKILL.md 必须以 --- 开头声明 frontmatter")
    lines = content.splitlines()
    end_index: int | None = None
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            end_index = index
            break
    if end_index is None:
        raise ValueError("SKILL.md frontmatter 缺少结束标记 ---")

    frontmatter_text = "\n".join(lines[1:end_index])
    body = "\n".join(lines[end_index + 1 :]).strip()
    try:
        raw = yaml.safe_load(frontmatter_text)
    except yaml.YAMLError as exc:
        raise ValueError(f"SKILL.md frontmatter 解析失败：{exc}") from exc
    if not isinstance(raw, dict):
        raise ValueError("SKILL.md frontmatter 必须是对象")
    return raw, body


def _extract_prompt_text(raw: dict[str, Any]) -> str:
    """从 skill.yaml 配置中取出内联 prompt 文本（v1 不支持附加文件）。"""

    prompt_value = raw.get("prompt") or "prompt.md"
    if isinstance(prompt_value, dict):
        inline = str(prompt_value.get("inline") or "").strip()
        if not inline:
            raise ValueError("外部 Skill 的 prompt 引用了文件，当前版本仅支持内联 prompt")
        return inline
    text = str(prompt_value).strip()
    if "\n" not in text and text.endswith((".md", ".yaml", ".yml")):
        raise ValueError("外部 Skill 的 prompt 引用了文件，当前版本仅支持内联 prompt")
    return text


def _convert_raw_content(raw_text: str, source_url: str) -> dict[str, Any]:
    """识别外部格式并转换为内部 skill.yaml 字段。"""

    stripped = raw_text.strip()
    if stripped.startswith("---"):
        frontmatter, body = _parse_frontmatter(stripped)
        if not body:
            raise ValueError("SKILL.md 正文为空，无法作为 Skill prompt")
        name = str(frontmatter.get("name") or "").strip()
        if not name:
            fallback = _url_slug_fallback(source_url)
            if not fallback:
                raise ValueError("SKILL.md frontmatter 缺少 name 字段")
            name = fallback
        return {
            "sourceFormat": "skill-md",
            "name": name,
            "version": str(frontmatter.get("version") or DEFAULT_VERSION).strip(),
            "description": str(frontmatter.get("description") or "").strip(),
            "tools": frontmatter.get("tools") or frontmatter.get("required_tools") or [],
            "memory": frontmatter.get("memory") or [],
            "permissions": frontmatter.get("permissions") or {},
            "requiresReasoning": bool(frontmatter.get("requires_reasoning", False)),
            "tags": frontmatter.get("tags") or [],
            "promptText": body,
        }

    try:
        raw = yaml.safe_load(stripped)
    except yaml.YAMLError as exc:
        raise ValueError("无法识别 Skill 格式（不是 SKILL.md，也不是有效的 YAML）") from exc
    if not isinstance(raw, dict):
        raise ValueError("外部 Skill YAML 必须是对象")
    identifier = str(raw.get("id") or raw.get("name") or "").strip()
    if not identifier:
        raise ValueError("外部 Skill YAML 缺少 id/name 字段")
    return {
        "sourceFormat": "skill-yaml",
        "name": str(raw.get("name") or identifier).strip(),
        "version": str(raw.get("version") or DEFAULT_VERSION).strip(),
        "description": str(raw.get("description") or "").strip(),
        "tools": raw.get("tools") or raw.get("required_tools") or [],
        "memory": raw.get("memory") or [],
        "permissions": raw.get("permissions") or {},
        "requiresReasoning": bool(raw.get("requires_reasoning", False)),
        "tags": raw.get("tags") or [],
        "promptText": _extract_prompt_text(raw),
    }


def _build_skill_yaml(converted: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """构造符合内部格式的 skill.yaml 与 prompt.md 内容。"""

    prompt_text = str(converted["promptText"]).strip()
    if not prompt_text:
        raise ValueError("Skill prompt 不能为空")

    raw_yaml = {
        "id": _to_skill_id(converted["name"]),
        "name": converted["name"][:80],
        "version": converted["version"] or DEFAULT_VERSION,
        "description": converted["description"],
        "scope": "user",
        "prompt": "prompt.md",
        "tools": converted["tools"],
        "memory": converted["memory"],
        "permissions": converted["permissions"],
        "requires_reasoning": converted["requiresReasoning"],
        "tags": converted["tags"],
    }
    validated = SkillValidator().validate(
        raw_yaml,
        path=Path(_user_skill_root()) / raw_yaml["id"] / "skill.yaml",
        scope="user",
    )
    return validated, prompt_text


def _skill_dir(skill_id: str) -> Path:
    """返回 skill_id 对应目录并做路径穿越防护。"""

    root = _user_skill_root().resolve()
    target = (root / skill_id).resolve()
    if not target.is_relative_to(root):
        raise ValueError(f"非法的 Skill 目录：{skill_id}")
    return target


async def _save_record(record: dict[str, Any]) -> int:
    """把安装记录写入 SQLite（同 id 覆盖更新）。

    启用状态统一在此处校验全局 50 个上限：超限时自动降级为停用，
    避免自动推荐安装路径绕过手动开关的限制。
    """

    requested_enabled = 1 if record.get("enabled", 0) else 0
    async with open_database() as connection:
        if requested_enabled:
            count_cursor = await connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM installed_skills
                WHERE enabled = 1 AND id != ?
                """,
                (str(record["id"]),),
            )
            count_row = await count_cursor.fetchone()
            if count_row is not None and int(count_row["count"]) >= 50:
                LOGGER.info(
                    "Skill %s 超过 50 个启用上限，自动降级为停用",
                    record["id"],
                )
                requested_enabled = 0
        await connection.execute(
            """
            INSERT INTO installed_skills (
                id, name, version, description, source_url, source_format,
                enabled, agent_ids, content_json, files_json,
                installed_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                version = excluded.version,
                description = excluded.description,
                source_url = excluded.source_url,
                source_format = excluded.source_format,
                content_json = excluded.content_json,
                files_json = excluded.files_json,
                updated_at = excluded.updated_at
            """,
            (
                record["id"],
                record["name"],
                record["version"],
                record["description"],
                record["source_url"],
                record["source_format"],
                requested_enabled,
                dumps_json(record.get("agent_ids") or []),
                record["content_json"],
                record["files_json"],
                record["installed_at"],
                record["updated_at"],
            ),
        )
    return requested_enabled


def _export_files(
    skill_id: str,
    skill_yaml: dict[str, Any],
    prompt_text: str,
    extra_files: dict[str, bytes] | None = None,
) -> None:
    """把 Skill 写入 user 级目录（幂等，可反复调用用于恢复）。

    ``extra_files`` 以相对路径为键，导出时保持目录结构并做路径穿越防护。
    """

    target = _skill_dir(skill_id)
    target.mkdir(parents=True, exist_ok=True)
    skill_yaml_path = target / "skill.yaml"
    prompt_path = target / "prompt.md"
    skill_yaml_path.write_text(
        yaml.safe_dump(skill_yaml, allow_unicode=True, sort_keys=False),
        "utf-8",
    )
    prompt_path.write_text(prompt_text, "utf-8")
    for relative, content in (extra_files or {}).items():
        normalized = relative.replace("\\", "/")
        if normalized.startswith("/") or ".." in normalized.split("/"):
            raise ValueError(f"非法的附加文件路径：{relative}")
        file_path = (target / normalized).resolve()
        if not file_path.is_relative_to(target):
            raise ValueError(f"附加文件路径越界：{relative}")
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.write_bytes(content)
    LOGGER.info("Skill 已导出到 %s", target)


async def install_skill_from_url(url: str) -> dict[str, Any]:
    """完整安装流：下载 → 转换 → 校验 → 导出文件 → 写入 SQLite。"""

    url = (url or "").strip()
    if not url:
        raise ValueError("请提供 Skill 安装地址")

    raw_text = await _download_text(url)
    converted = _convert_raw_content(raw_text, url)
    skill_yaml, prompt_text = _build_skill_yaml(converted)
    skill_id = str(skill_yaml["id"])
    recommended_agents = _recommend_agents(
        name=str(skill_yaml["name"]),
        description=str(skill_yaml["description"]),
        tags=tuple(skill_yaml.get("tags") or ()),
    )

    # 先导出文件，再写 SQLite；数据库写入失败时清理已导出的目录。
    try:
        _export_files(skill_id, skill_yaml, prompt_text)
        now = utc_now_iso()
        final_enabled = await _save_record(
            {
                "id": skill_id,
                "name": str(skill_yaml["name"]),
                "version": str(skill_yaml["version"]),
                "description": str(skill_yaml["description"]),
                "source_url": url,
                "source_format": str(converted["sourceFormat"]),
                "enabled": 1 if recommended_agents else 0,
                "agent_ids": recommended_agents,
                "content_json": dumps_json(
                    {"yaml": skill_yaml, "prompt": prompt_text}
                ),
                "files_json": "{}",
                "installed_at": now,
                "updated_at": now,
            }
        )
    except Exception:
        shutil.rmtree(_skill_dir(skill_id), ignore_errors=True)
        raise

    LOGGER.info("外部 Skill 安装完成：%s (%s)", skill_id, url)
    return {
        "id": skill_id,
        "name": str(skill_yaml["name"]),
        "version": str(skill_yaml["version"]),
        "description": str(skill_yaml["description"]),
        "sourceUrl": url,
        "sourceFormat": str(converted["sourceFormat"]),
        "enabled": bool(final_enabled),
    }


async def _install_extracted(
    *,
    skill_text: str,
    extra_files: dict[str, bytes],
    display_url: str,
) -> dict[str, Any]:
    """把已提取的 Skill 内容完成 转换 → 导出 → 入库，返回摘要。"""

    converted = _convert_raw_content(skill_text, display_url)
    skill_yaml, prompt_text = _build_skill_yaml(converted)
    skill_id = str(skill_yaml["id"])
    recommended_agents = _recommend_agents(
        name=str(skill_yaml["name"]),
        description=str(skill_yaml["description"]),
        tags=tuple(skill_yaml.get("tags") or ()),
    )

    try:
        _export_files(skill_id, skill_yaml, prompt_text, extra_files)
        now = utc_now_iso()
        final_enabled = await _save_record(
            {
                "id": skill_id,
                "name": str(skill_yaml["name"]),
                "version": str(skill_yaml["version"]),
                "description": str(skill_yaml["description"]),
                "source_url": display_url,
                "source_format": f"github:{converted['sourceFormat']}",
                "enabled": 1 if recommended_agents else 0,
                "agent_ids": recommended_agents,
                "content_json": dumps_json(
                    {"yaml": skill_yaml, "prompt": prompt_text}
                ),
                "files_json": dumps_json(_encode_extra_files(extra_files)),
                "installed_at": now,
                "updated_at": now,
            }
        )
    except Exception:
        shutil.rmtree(_skill_dir(skill_id), ignore_errors=True)
        raise

    LOGGER.info("GitHub Skill 安装完成：%s (%s)", skill_id, display_url)
    return {
        "id": skill_id,
        "name": str(skill_yaml["name"]),
        "version": str(skill_yaml["version"]),
        "description": str(skill_yaml["description"]),
        "sourceUrl": display_url,
        "sourceFormat": f"github:{converted['sourceFormat']}",
        "extraFileCount": len(extra_files),
        "enabled": bool(final_enabled),
    }


async def install_skill_from_github(source: str) -> dict[str, Any]:
    """GitHub 安装流：解析 → 下载 tarball → 提取 → 转换 → 导出 → 入库。

    未指定子目录时：
    - 仓库根目录含 SKILL.md → 安装单个 Skill；
    - 根目录没有 SKILL.md → 自动批量安装仓库内所有含 SKILL.md 的目录。
    """

    owner, repo, ref, subpath = _parse_github_spec(source)
    tarball = await _download_github_tarball(owner, repo, ref)
    base_url = (
        f"https://github.com/{owner}/{repo}"
        + (f"/tree/{ref}" if ref else "")
    )

    if subpath:
        skill_text, extra_files = _extract_skill_files(tarball, subpath)
        installed = await _install_extracted(
            skill_text=skill_text,
            extra_files=extra_files,
            display_url=f"{base_url}/{subpath}",
        )
        return {"installed": [installed], "failed": [], "total": 1}

    # 未指定子目录：先尝试仓库根目录的 SKILL.md。
    try:
        skill_text, extra_files = _extract_skill_files(tarball, "")
        installed = await _install_extracted(
            skill_text=skill_text,
            extra_files=extra_files,
            display_url=base_url,
        )
        return {"installed": [installed], "failed": [], "total": 1}
    except ValueError as exc:
        if "SKILL.md" not in str(exc):
            raise

    # 根目录没有 SKILL.md → 批量安装仓库内所有 Skill。
    directories = _find_skill_directories(tarball)
    if not directories:
        raise ValueError("仓库中没有找到任何 SKILL.md")
    installed_list: list[dict[str, Any]] = []
    failed_list: list[dict[str, Any]] = []
    for directory in directories:
        try:
            skill_text, extra_files = _extract_skill_files(tarball, directory)
            installed_list.append(
                await _install_extracted(
                    skill_text=skill_text,
                    extra_files=extra_files,
                    display_url=f"{base_url}/{directory}",
                )
            )
        except Exception as exc:
            failed_list.append(
                {"path": directory, "error": str(exc)[:300]}
            )
            LOGGER.warning("批量安装失败：%s（%s）", directory, exc)

    LOGGER.info(
        "GitHub 批量安装完成：成功 %s / 失败 %s / 共 %s",
        len(installed_list),
        len(failed_list),
        len(directories),
    )
    return {
        "installed": installed_list,
        "failed": failed_list,
        "total": len(directories),
    }


async def install_skill(source: str) -> dict[str, Any]:
    """统一安装入口：自动识别 GitHub 仓库标识与 http(s) 直链。"""

    value = (source or "").strip()
    if not value:
        raise ValueError("请提供 Skill 安装地址")
    lowered = value.lower()
    if lowered.startswith(("https://github.com/", "http://github.com/")):
        return await install_skill_from_github(value)
    if lowered.startswith(("http://", "https://")):
        installed = await install_skill_from_url(value)
        return {"installed": [installed], "failed": [], "total": 1}
    owner_repo_part = value.split("@", 1)[0]
    owner_repo_segments = owner_repo_part.split("/")
    if len(owner_repo_segments) >= 2 and GITHUB_REPO_PATTERN.fullmatch(
        f"{owner_repo_segments[0]}/{owner_repo_segments[1]}"
    ):
        return await install_skill_from_github(value)
    raise ValueError("无法识别的安装地址：支持 http(s) 链接或 owner/repo 格式")


async def uninstall_skill(skill_id: str) -> dict[str, Any]:
    """卸载：删除 SQLite 记录与 user 级目录。"""

    skill_id = (skill_id or "").strip()
    if not skill_id:
        raise KeyError("缺少 Skill id")
    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT id, name, source_url FROM installed_skills WHERE id = ?",
            (skill_id,),
        )
        row = await cursor.fetchone()
        if row is None:
            raise KeyError(f"未安装 Skill：{skill_id}")
        await connection.execute(
            "DELETE FROM installed_skills WHERE id = ?",
            (skill_id,),
        )

    shutil.rmtree(_skill_dir(skill_id), ignore_errors=True)
    LOGGER.info("Skill 已卸载：%s", skill_id)
    return {
        "id": skill_id,
        "name": str(row["name"]),
        "sourceUrl": str(row["source_url"]),
    }


async def restore_installed_skills() -> int:
    """启动恢复：SQLite 有记录但文件缺失时，从持久化内容重建。"""

    restored = 0
    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT id, content_json, files_json FROM installed_skills"
        )
        rows = await cursor.fetchall()

    for row in rows:
        skill_id = str(row["id"])
        if (_user_skill_root() / skill_id / "skill.yaml").is_file():
            continue
        content = loads_json(str(row["content_json"]), None)
        if not isinstance(content, dict):
            LOGGER.warning("Skill %s 持久化内容损坏，跳过恢复", skill_id)
            continue
        skill_yaml = content.get("yaml")
        prompt_text = content.get("prompt")
        if not isinstance(skill_yaml, dict) or not isinstance(prompt_text, str):
            LOGGER.warning("Skill %s 持久化内容不完整，跳过恢复", skill_id)
            continue
        try:
            extra_files = _decode_extra_files(
                loads_json(str(row["files_json"] or "{}"), {})
            )
            _export_files(skill_id, skill_yaml, prompt_text, extra_files)
            restored += 1
        except Exception:
            LOGGER.exception("Skill %s 恢复失败", skill_id)
    if restored:
        LOGGER.info("已从 SQLite 恢复 %s 个外部 Skill", restored)
    return restored


async def list_installed_skills() -> list[dict[str, Any]]:
    """返回 SQLite 中的安装记录（含文件是否存在的状态）。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            """
            SELECT s.id, s.name, s.version, s.description, s.source_url,
                   s.source_format, s.enabled, s.agent_ids,
                   s.installed_at, s.updated_at,
                   COALESCE(u.hit_count, 0) AS hit_count
            FROM installed_skills s
            LEFT JOIN skill_usage u ON u.skill_id = s.id
            ORDER BY installed_at DESC
            """
        )
        rows = await cursor.fetchall()

    skills: list[dict[str, Any]] = []
    for row in rows:
        skill_id = str(row["id"])
        skills.append(
            {
                "id": skill_id,
                "name": str(row["name"]),
                "version": str(row["version"]),
                "description": str(row["description"]),
                "sourceUrl": str(row["source_url"]),
                "sourceFormat": str(row["source_format"]),
                "enabled": bool(row["enabled"]),
                "agentIds": loads_json(str(row["agent_ids"] or "[]"), []),
                "hitCount": int(row["hit_count"] or 0),
                "installedAt": str(row["installed_at"]),
                "updatedAt": str(row["updated_at"]),
                "filesExist": (_user_skill_root() / skill_id / "skill.yaml").is_file(),
            }
        )
    return skills


async def update_skill_config(
    skill_id: str,
    *,
    enabled: bool,
    agent_ids: list[str],
) -> dict[str, Any]:
    """更新 Skill 的启用配置：总开关与绑定的 Agent 列表。"""

    skill_id = (skill_id or "").strip()
    normalized_agents = list(
        dict.fromkeys(
            str(item).strip()
            for item in (agent_ids or [])
            if str(item).strip()
        )
    )
    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT id FROM installed_skills WHERE id = ?",
            (skill_id,),
        )
        if await cursor.fetchone() is None:
            raise KeyError(f"未安装 Skill：{skill_id}")
        if enabled:
            count_cursor = await connection.execute(
                """
                SELECT COUNT(*) AS count
                FROM installed_skills
                WHERE enabled = 1 AND id != ?
                """,
                (skill_id,),
            )
            count_row = await count_cursor.fetchone()
            if count_row is not None and int(count_row["count"]) >= 50:
                raise ValueError("同时启用的 Skill 不能超过 50 个")
        await connection.execute(
            """
            UPDATE installed_skills
            SET enabled = ?, agent_ids = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                1 if enabled else 0,
                dumps_json(normalized_agents),
                utc_now_iso(),
                skill_id,
            ),
        )
    return {"id": skill_id, "enabled": enabled, "agentIds": normalized_agents}


async def list_enabled_skills_for_agent(
    agent_id: str,
    *,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """返回绑定到指定 Agent 且已启用的 Skill 候选池（上限 50 条）。"""

    agent_id = (agent_id or "").strip()
    if not agent_id:
        return []
    async with open_database() as connection:
        cursor = await connection.execute(
            """
            SELECT id, name, description, content_json
            FROM installed_skills
            WHERE enabled = 1 AND agent_ids LIKE ?
            ORDER BY installed_at DESC
            LIMIT ?
            """,
            (f'%"{agent_id}"%', max(1, min(limit, 200))),
        )
        rows = await cursor.fetchall()
    candidates: list[dict[str, Any]] = []
    for row in rows:
        content = loads_json(str(row["content_json"] or "{}"), {})
        skill_yaml = content.get("yaml") if isinstance(content, dict) else None
        tags = (
            tuple(str(item) for item in skill_yaml.get("tags") or [])
            if isinstance(skill_yaml, dict)
            else ()
        )
        candidates.append(
            {
                "id": str(row["id"]),
                "name": str(row["name"]),
                "description": str(row["description"]),
                "tags": tags,
            }
        )
    return candidates


async def record_skill_usage(skill_id: str) -> None:
    """记录一次 Skill 被实际选中使用的次数。"""

    async with open_database() as connection:
        await connection.execute(
            """
            INSERT INTO skill_usage (skill_id, hit_count, last_used_at)
            VALUES (?, 1, ?)
            ON CONFLICT(skill_id) DO UPDATE SET
                hit_count = hit_count + 1,
                last_used_at = excluded.last_used_at
            """,
            (skill_id, utc_now_iso()),
        )
