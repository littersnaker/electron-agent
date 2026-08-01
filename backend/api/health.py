"""健康检查接口，并公开不含密钥的开发源码身份。"""

from __future__ import annotations

import os
import sys
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from backend.core.timezones import PACIFIC_TIMEZONE, timezone_source


router = APIRouter(tags=["health"])
SOURCE_FILE = Path(__file__).resolve()
SOURCE_ROOT = SOURCE_FILE.parents[2]


def _source_modified_at() -> str:
    """返回当前健康检查源码的最后修改时间，便于判断是否运行了新代码。"""

    timestamp = SOURCE_FILE.stat().st_mtime
    return datetime.fromtimestamp(timestamp, tz=UTC).isoformat()


@router.get("/api/health")
async def health_check() -> JSONResponse:
    """返回服务状态、源码目录和进程信息，并禁止中间层缓存结果。"""

    payload = {
        "ok": True,
        "service": "multi-agent-fastapi",
        "version": 2,
        "runtime": "packaged" if getattr(sys, "frozen", False) else "source",
        "reloadEnabled": os.getenv("BACKEND_RELOAD", "") == "1",
        "processId": os.getpid(),
        "sourceRoot": str(SOURCE_ROOT),
        "sourceFile": str(SOURCE_FILE),
        "sourceModifiedAt": _source_modified_at(),
        "pythonExecutable": sys.executable,
        "timeZoneSupport": timezone_source(PACIFIC_TIMEZONE),
    }
    return JSONResponse(
        content=payload,
        headers={"Cache-Control": "no-store, no-cache, must-revalidate"},
    )
