"""工作区敏感路径识别与软过滤工具。

本模块只根据相对路径名称做安全判定，不读取文件内容。搜索、索引、Harness 和 Code Agent
工具共用同一套规则，避免某个入口隐藏了敏感文件、另一个入口却又把路径暴露给模型。
"""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import PurePosixPath

_SAFE_ENV_TEMPLATES = {
    ".env.example",
    ".env.sample",
    ".env.template",
    ".env.example.local",
}
_SENSITIVE_DIRECTORY_NAMES = {".ssh", ".aws", ".gnupg", ".azure"}
_SENSITIVE_EXACT_NAMES = {
    ".netrc",
    "credentials.json",
    "secrets.json",
    "service-account.json",
    "service_account.json",
    "id_rsa",
    "id_ed25519",
}
_SENSITIVE_SUFFIXES = {".pem", ".key", ".p12", ".pfx", ".jks"}


def normalize_workspace_path(value: object) -> str:
    """把外部路径值转换为稳定的工作区相对路径表示。"""

    return str(value or "").strip().replace("\\", "/").strip("/")


def is_sensitive_workspace_path(value: object) -> bool:
    """判断相对路径是否可能包含环境变量、私钥或云凭据。"""

    normalized = normalize_workspace_path(value).lower()
    if not normalized:
        return False
    path = PurePosixPath(normalized)
    parts = tuple(part for part in path.parts if part not in {"", "."})
    if any(part in _SENSITIVE_DIRECTORY_NAMES for part in parts):
        return True

    name = path.name
    if name in _SAFE_ENV_TEMPLATES:
        return False
    if name == ".env" or name.startswith(".env."):
        return True
    if name in _SENSITIVE_EXACT_NAMES:
        return True
    return any(name.endswith(suffix) for suffix in _SENSITIVE_SUFFIXES)


def partition_safe_workspace_paths(values: Iterable[object]) -> tuple[list[str], list[str]]:
    """去重路径并分成可访问路径与被安全策略跳过的敏感路径。"""

    safe: list[str] = []
    blocked: list[str] = []
    for value in values:
        normalized = normalize_workspace_path(value)
        if not normalized:
            continue
        target = blocked if is_sensitive_workspace_path(normalized) else safe
        if normalized not in target:
            target.append(normalized)
    return safe, blocked


def render_sensitive_skip(blocked_paths: Iterable[str]) -> str:
    """把被过滤路径渲染为不会触发返工的模型观察文本。"""

    paths = list(dict.fromkeys(path for path in blocked_paths if path))
    if not paths:
        return ""
    rendered = "\n".join(f"- {path}" for path in paths)
    return (
        "SECURITY SKIP：以下敏感路径已在工具执行前过滤，没有读取、搜索或输出内容：\n"
        f"{rendered}\n"
        "不要再次请求这些路径。需要配置结构时，请改读 .env.example、类型定义、"
        "构建配置或源码中使用到的环境变量名称，并继续完成当前任务。"
    )


__all__ = [
    "is_sensitive_workspace_path",
    "normalize_workspace_path",
    "partition_safe_workspace_paths",
    "render_sensitive_skip",
]
