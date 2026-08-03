"""根据真实项目文件识别前端框架和推荐源码目录。"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True, slots=True)
class FrontendProjectProfile:
    """保存项目技术栈识别结果。"""

    stack: str
    source_root: str
    project_name: str
    evidence: tuple[str, ...]

    def to_json(self) -> dict[str, object]:
        """转换成 Software Factory 计划可以公开的摘要。"""

        return {
            "stack": self.stack,
            "sourceRoot": self.source_root,
            "projectName": self.project_name,
            "evidence": list(self.evidence),
        }


def detect_frontend_profile(root: Path) -> FrontendProjectProfile:
    """读取项目配置并识别微信小程序、React、Vue 或通用 TypeScript。"""

    resolved_root = root.resolve()
    evidence: list[str] = []
    package = _read_package_json(resolved_root)
    project_name = str(package.get("name") or resolved_root.name or "software-project")

    # 微信开发者工具项目通常具有 project.config.json 或 miniprogram 目录。
    if (resolved_root / "project.config.json").is_file() or (
        resolved_root / "miniprogram"
    ).is_dir():
        evidence.append("检测到 project.config.json 或 miniprogram 目录")
        source_root = "miniprogram" if (resolved_root / "miniprogram").exists() else "."
        return FrontendProjectProfile(
            "wechat-miniprogram",
            source_root,
            project_name,
            tuple(evidence),
        )

    dependencies = {
        **dict(package.get("dependencies") or {}),
        **dict(package.get("devDependencies") or {}),
    }
    if "next" in dependencies:
        evidence.append("package.json 包含 next")
        return FrontendProjectProfile(
            "next-react",
            _source_root(resolved_root),
            project_name,
            tuple(evidence),
        )
    if "react" in dependencies:
        evidence.append("package.json 包含 react")
        return FrontendProjectProfile(
            "react",
            _source_root(resolved_root),
            project_name,
            tuple(evidence),
        )
    if "vue" in dependencies:
        evidence.append("package.json 包含 vue")
        return FrontendProjectProfile(
            "vue",
            _source_root(resolved_root),
            project_name,
            tuple(evidence),
        )

    # 未识别框架时仍返回稳定目录，后续 Agent 可以根据真实代码调整生成路径。
    evidence.append("未识别专用框架，使用通用 TypeScript 模板")
    return FrontendProjectProfile(
        "typescript",
        _source_root(resolved_root),
        project_name,
        tuple(evidence),
    )


def _read_package_json(root: Path) -> dict[str, object]:
    """安全读取 package.json；文件缺失或无效时返回空对象。"""

    path = root / "package.json"
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text("utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


def _source_root(root: Path) -> str:
    """按常见优先级选择源码根目录。"""

    for candidate in ("src", "app"):
        if (root / candidate).is_dir():
            return candidate
    return "src"
