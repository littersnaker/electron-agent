"""应用配置读取模块。

本文件只负责把环境变量转换成 Python 可用的配置对象。为了方便前端工程师理解，
没有引入复杂的依赖注入框架；所有配置都通过 ``get_settings()`` 统一读取。
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv


def _project_root() -> Path:
    """返回当前项目根目录。

    开发环境中，根目录就是 ``backend`` 文件夹的上一级；PyInstaller 打包后，
    ``sys.executable`` 指向生成的后端可执行文件，因此使用其所在目录作为兜底。
    """

    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def _desktop_app_data_root() -> Path:
    """按操作系统返回与 Electron app.getPath("appData") 对应的目录。"""

    if sys.platform == "win32":
        base = os.getenv("APPDATA", "").strip()
        return Path(base).expanduser() if base else Path.home() / "AppData" / "Roaming"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support"
    configured = os.getenv("XDG_CONFIG_HOME", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".config"


def _default_data_directory() -> Path:
    """开发桌面模式复用安装版数据，其余独立 Python 运行仍使用项目目录。"""

    if os.getenv("MULTI_AGENT_DESKTOP_DEV", "") == "1":
        return _desktop_app_data_root() / "Multi-agent" / "python-data"
    return _project_root() / ".local-data"


def _load_environment_file() -> Path | None:
    """按优先级加载本地环境变量文件，并返回实际加载的路径。

    优先读取 Electron 通过 ``APP_ENV_FILE`` 指定的文件；如果没有指定，则读取项目根目录
    下的 ``.env.local``。该函数只加载变量，不打印变量值，避免 API Key 出现在日志中。
    """

    configured = os.getenv("APP_ENV_FILE", "").strip()
    candidates = [Path(configured)] if configured else []
    candidates.append(_project_root() / ".env.local")

    for candidate in candidates:
        if candidate.is_file():
            load_dotenv(candidate, override=False)
            return candidate
    return None


@dataclass(frozen=True, slots=True)
class Settings:
    """保存后端运行所需的全部基础配置。"""

    host: str
    port: int
    data_dir: Path
    frontend_dir: Path | None
    log_level: str
    request_timeout_seconds: float
    max_upload_megabytes: int
    environment_file: Path | None

    @property
    def database_path(self) -> Path:
        """返回 SQLite 数据库文件路径。"""

        return self.data_dir / "workspace.db"

    @property
    def media_cache_dir(self) -> Path:
        """返回媒体下载缓存目录。"""

        return self.data_dir / "media-cache"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """读取并缓存应用配置。

    返回值在同一个进程中保持不变，避免每个请求都重新解析环境变量。
    """

    environment_file = _load_environment_file()
    data_dir = Path(
        os.getenv("AGENT_DATA_DIR", str(_default_data_directory()))
    ).expanduser().resolve()
    frontend_raw = os.getenv("FRONTEND_DIR", "").strip()
    frontend_dir = Path(frontend_raw).expanduser().resolve() if frontend_raw else None

    data_dir.mkdir(parents=True, exist_ok=True)
    (data_dir / "media-cache").mkdir(parents=True, exist_ok=True)

    return Settings(
        host=os.getenv("BACKEND_HOST", "127.0.0.1"),
        port=int(os.getenv("BACKEND_PORT", "8765")),
        data_dir=data_dir,
        frontend_dir=frontend_dir,
        log_level=os.getenv("LOG_LEVEL", "INFO").upper(),
        request_timeout_seconds=float(os.getenv("REQUEST_TIMEOUT_SECONDS", "120")),
        max_upload_megabytes=int(os.getenv("MAX_UPLOAD_MEGABYTES", "40")),
        environment_file=environment_file,
    )
