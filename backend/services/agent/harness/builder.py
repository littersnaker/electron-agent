"""基于真实工作区构建低 Token Project Harness。"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from backend.services.agent.harness.models import ProjectHarness
from backend.services.agent.shared.domain_rules import harness_rules
from backend.services.agent.shared.work_models import WorkItem
from backend.services.workspace.indexer import iter_project_files
from backend.utils.paths import is_probably_binary
from backend.utils.sensitive_paths import is_sensitive_workspace_path

_SKILL_HEADER = re.compile(r"^## Skill · ([^@\n]+)@[^\n]+$", re.MULTILINE)
_ENTRY_CANDIDATES = (
    "package.json",
    "src/app.tsx",
    "src/app.ts",
    "src/main.tsx",
    "src/main.ts",
    "src/app.config.ts",
    "src/app.config.js",
    "app.json",
    "pages.json",
    "project.config.json",
)
_MAX_SEED_FILES = 8
_MAX_SEED_FILE_CHARS = 4_000
_MAX_DISCOVERY_FILES = 4
_TEXT_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".vue", ".json", ".py", ".scss", ".css"}
def _domain_path_hints() -> tuple[tuple[tuple[str, ...], tuple[str, ...]], ...]:
    """从配置读取功能域路径提示，避免业务词写死在代码里。"""

    raw = harness_rules().get("domainPathHints") or []
    return tuple(
        (tuple(str(item) for item in entry.get("terms") or ()),
         tuple(str(item) for item in entry.get("paths") or ()))
        for entry in raw
        if isinstance(entry, dict)
    )


def build_project_harness(
    *,
    root: Path,
    request_text: str,
    runtime_context: str = "",
) -> ProjectHarness:
    """读取少量清单与入口文件，构建可恢复的工程执行 Harness。"""

    package = _read_package_json(root)
    dependencies = _dependency_names(package)
    scripts = _script_map(package)
    framework = _detect_framework(root, dependencies)
    manager = _detect_package_manager(root)
    source_root = _detect_source_root(root)
    entries = [path for path in _ENTRY_CANDIDATES if (root / path).is_file()]
    config_files = _config_files(root)
    skill_ids, skill_directives = _extract_skill_directives(runtime_context)
    normalized_request = request_text.lower()
    rules = harness_rules()
    ui_terms = tuple(str(item) for item in rules.get("uiTerms") or ())
    commerce_terms = tuple(str(item) for item in rules.get("commerceTerms") or ())
    commerce_task_kind = str(rules.get("commerceTaskKind") or "commerce-miniapp")

    # Runtime 尚未注入动态 Skill 时，仍使用同一份紧凑 UI 规范兜底，保证恢复任务行为一致。
    if any(term in normalized_request for term in ui_terms):
        if "apple-miniapp-ui" not in skill_ids:
            skill_ids.append("apple-miniapp-ui")
        skill_directives.append(
            "UI 使用清晰层级、44px 以上触控区、8px 间距网格、系统字体、克制阴影，"
            "并覆盖 loading、error、empty、success 状态。"
        )
    task_kind = (
        commerce_task_kind
        if any(term in normalized_request for term in commerce_terms)
        else "coding"
    )
    return ProjectHarness(
        framework=framework,
        package_manager=manager,
        source_root=source_root,
        entry_files=entries[:10],
        config_files=config_files[:10],
        quality_commands=_quality_commands(manager, scripts),
        skill_ids=list(dict.fromkeys(skill_ids)),
        skill_directives=list(dict.fromkeys(skill_directives))[:6],
        task_kind=task_kind,
    )


def build_work_seed_context(
    *,
    root: Path,
    harness: ProjectHarness,
    work: WorkItem,
) -> str:
    """预读当前 Work 的具体目标文件和工程入口，减少模型搜索轮次。"""

    candidates = [
        *work.target_files,
        *harness.entry_files,
        *harness.config_files,
    ]
    selected: list[str] = []
    for raw_path in candidates:
        path = raw_path.replace("\\", "/").strip().strip("/")
        if not path or path in selected or is_sensitive_workspace_path(path):
            continue
        target = root / path
        if target.is_file() and not is_probably_binary(target):
            selected.append(path)
        if len(selected) >= _MAX_SEED_FILES:
            break

    # Planner 只给出不存在的新文件时，Harness 从源码根本地找少量同域文件，
    # 避免 Worker 先 search 再逐个 read，且不会把全仓库内容送入模型。
    if len(selected) < _MAX_SEED_FILES:
        selected.extend(
            _discover_related_files(
                root=root,
                harness=harness,
                work=work,
                excluded=set(selected),
                limit=min(_MAX_DISCOVERY_FILES, _MAX_SEED_FILES - len(selected)),
            )
        )

    sections: list[str] = []
    for path in selected:
        try:
            content = (root / path).read_text("utf-8", errors="replace")
        except OSError:
            continue
        sections.append(
            f"--- FILE: {path} [Harness 预读] ---\n{content[:_MAX_SEED_FILE_CHARS]}"
        )
    return "\n\n".join(sections)



def _discover_related_files(
    *,
    root: Path,
    harness: ProjectHarness,
    work: WorkItem,
    excluded: set[str],
    limit: int,
) -> list[str]:
    """按功能域和文件名评分，预读少量现有实现供 Worker 直接修改。"""

    if limit <= 0:
        return []
    searchable = f"{work.title} {work.objective}".lower()
    hints: set[str] = {
        token.lower()
        for token in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", searchable)
    }
    for request_terms, path_terms in _domain_path_hints():
        if any(term in searchable for term in request_terms):
            hints.update(path_terms)
    if not hints:
        return []

    source = root if harness.source_root == "." else root / harness.source_root
    if not source.is_dir():
        return []
    scored: list[tuple[int, str]] = []
    inspected = 0
    prefix = "" if source == root else f"{source.relative_to(root).as_posix()}/"
    for relative in iter_project_files(root):
        if prefix and not relative.startswith(prefix):
            continue
        inspected += 1
        if inspected > 2_000:
            break
        if relative in excluded or is_sensitive_workspace_path(relative):
            continue
        candidate = root / relative
        try:
            if (
                candidate.suffix.lower() not in _TEXT_SUFFIXES
                or candidate.stat().st_size > 200_000
                or is_probably_binary(candidate)
            ):
                continue
        except OSError:
            continue
        normalized = relative.lower()
        score = sum(3 for hint in hints if hint in normalized)
        if score:
            # 更浅的现有页面、Store 和 API 文件通常比深层生成物更适合作为入口。
            score += max(0, 6 - normalized.count("/"))
            scored.append((score, relative))

    scored.sort(key=lambda item: (-item[0], item[1]))
    return [relative for _, relative in scored[:limit]]

def _extract_skill_directives(runtime_context: str) -> tuple[list[str], list[str]]:
    """从统一 Runtime Context 中提取 Skill，而不携带 Memory 和会话历史。"""

    matches = list(_SKILL_HEADER.finditer(runtime_context))
    identifiers: list[str] = []
    directives: list[str] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(runtime_context)
        block = runtime_context[match.end() : end]
        # 下一个非 Skill 标题属于 Memory 或历史，不能误并入 Skill 内容。
        next_heading = re.search(r"^## (?!Skill · ).+$", block, re.MULTILINE)
        if next_heading:
            block = block[: next_heading.start()]
        identifier = match.group(1).strip()
        compact = " ".join(block.split())[:900]
        if identifier and compact:
            identifiers.append(identifier)
            directives.append(f"Skill {identifier}：{compact}")
    return identifiers, directives


def _read_package_json(root: Path) -> dict[str, Any]:
    """读取 package.json；格式异常时返回空对象，不阻断代码任务。"""

    path = root / "package.json"
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _dependency_names(package: dict[str, Any]) -> set[str]:
    """合并 dependencies 与 devDependencies 的包名集合。"""

    names: set[str] = set()
    for key in ("dependencies", "devDependencies"):
        value = package.get(key)
        if isinstance(value, dict):
            names.update(str(name).lower() for name in value)
    return names


def _script_map(package: dict[str, Any]) -> dict[str, str]:
    """读取 package scripts，并过滤非字符串值。"""

    raw = package.get("scripts")
    if not isinstance(raw, dict):
        return {}
    return {str(key): str(value) for key, value in raw.items() if isinstance(value, str)}


def _detect_framework(root: Path, dependencies: set[str]) -> str:
    """根据依赖和配置文件识别主要前端框架。"""

    if any(name.startswith("@tarojs/") for name in dependencies):
        return "Taro 小程序"
    if "@dcloudio/uni-app" in dependencies or (root / "pages.json").is_file():
        return "uni-app 小程序"
    if (root / "app.json").is_file() and (root / "project.config.json").is_file():
        return "微信原生小程序"
    if "next" in dependencies:
        return "Next.js"
    if "react" in dependencies:
        return "React"
    if "vue" in dependencies:
        return "Vue"
    return "unknown"


def _detect_package_manager(root: Path) -> str:
    """根据锁文件选择项目真实包管理器。"""

    for filename, manager in (
        ("pnpm-lock.yaml", "pnpm"),
        ("yarn.lock", "yarn"),
        ("bun.lockb", "bun"),
        ("package-lock.json", "npm"),
    ):
        if (root / filename).exists():
            return manager
    return "npm" if (root / "package.json").is_file() else ""


def _detect_source_root(root: Path) -> str:
    """返回最可能的源码根目录。"""

    for candidate in ("src", "miniprogram", "app"):
        if (root / candidate).is_dir():
            return candidate
    return "."


def _config_files(root: Path) -> list[str]:
    """收集影响路由、类型和构建的少量配置文件。"""

    names = (
        "tsconfig.json",
        "eslint.config.mjs",
        ".eslintrc.js",
        "vite.config.ts",
        "config/index.ts",
        "src/app.config.ts",
        "app.json",
        "pages.json",
    )
    return [name for name in names if (root / name).is_file()]


def _quality_commands(manager: str, scripts: dict[str, str]) -> list[str]:
    """从 package scripts 生成确定性质量命令，避免模型反复猜测。"""

    if not manager:
        return []
    commands: list[str] = []
    for script in ("lint", "typecheck", "test", "build"):
        if script in scripts:
            commands.append(f"{manager} run {script}")
    return commands[:4]



__all__ = ["build_project_harness", "build_work_seed_context"]
