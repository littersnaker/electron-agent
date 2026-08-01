"""健康检查接口。

启动探针必须尽量少做工作。尤其在 PyInstaller 安装包中，模块 ``__file__`` 只是
逻辑上的包内路径，并不保证对应源码文件可以被 ``stat``。因此存活探针与诊断信息
分离：Electron 只依赖 ``/api/health/live``，详细接口中的所有可选信息均安全降级。
"""

from __future__ import annotations

import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse


router = APIRouter(tags=["health"])
SOURCE_FILE = Path(__file__).resolve()
SOURCE_ROOT = SOURCE_FILE.parents[2]


def _runtime_file() -> Path:
    """返回当前运行时最可靠的身份文件。

    源码运行时使用健康检查模块；PyInstaller 运行时改用真实可执行文件，避免对
    PYZ 归档中的逻辑 ``__file__`` 路径执行文件系统操作。
    """

    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve()
    return SOURCE_FILE


def _safe_modified_at(path: Path) -> str | None:
    """安全读取文件修改时间；路径不存在或无权限时返回 ``None``。"""

    try:
        timestamp = path.stat().st_mtime
    except OSError:
        return None
    return datetime.fromtimestamp(timestamp, tz=UTC).isoformat()


def _safe_timezone_support() -> str:
    """延迟读取时区支持状态，任何诊断异常都不能破坏健康检查。"""

    try:
        from backend.core.timezones import PACIFIC_TIMEZONE, timezone_source

        return timezone_source(PACIFIC_TIMEZONE)
    except Exception:  # noqa: BLE001 - 健康检查必须对可选诊断信息容错。
        return "diagnostic-unavailable"


def _runtime_root() -> Path:
    """返回源码根目录或打包后端可执行文件所在目录。"""

    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return SOURCE_ROOT


@router.get("/api/health/live")
async def liveness_check() -> JSONResponse:
    """返回最轻量的存活结果，供 Electron 启动阶段轮询。

    该接口不读取源码文件、不访问 SQLite、不解析模型，也不依赖时区数据库。只要
    Uvicorn 已经完成应用启动，它就应稳定返回 HTTP 200。
    """

    return JSONResponse(
        content={"ok": True, "service": "multi-agent-fastapi"},
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )


@router.get("/api/health")
async def health_check() -> JSONResponse:
    """返回运行时诊断信息；可选字段失败时仍保持 HTTP 200。"""

    identity_file = _runtime_file()
    payload = {
        "ok": True,
        "service": "multi-agent-fastapi",
        "version": 3,
        "runtime": "packaged" if getattr(sys, "frozen", False) else "source",
        "reloadEnabled": os.getenv("BACKEND_RELOAD", "") == "1",
        "processId": os.getpid(),
        "sourceRoot": str(_runtime_root()),
        "sourceFile": str(identity_file),
        "sourceModifiedAt": _safe_modified_at(identity_file),
        "pythonExecutable": sys.executable,
        "timeZoneSupport": _safe_timezone_support(),
    }
    return JSONResponse(
        content=payload,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )
