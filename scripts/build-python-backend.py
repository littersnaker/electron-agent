"""使用 PyInstaller 构建可由 Electron 启动的单文件 FastAPI 后端。"""

from __future__ import annotations

import importlib.util
import shutil
from pathlib import Path

import PyInstaller.__main__

from embed_builtin_credentials import embed_builtin_credentials
from sync_model_catalog import sync_model_catalog


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIRECTORY = ROOT / "python-dist"
WORK_DIRECTORY = ROOT / ".python-build"
SPEC_DIRECTORY = ROOT / ".python-spec"


def clean_previous_build() -> None:
    """删除旧的 Python 构建产物，避免把过期模块打进安装包。"""

    for directory in (OUTPUT_DIRECTORY, WORK_DIRECTORY, SPEC_DIRECTORY):
        shutil.rmtree(directory, ignore_errors=True)
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)


def _pyinstaller_arguments() -> list[str]:
    """生成 PyInstaller 参数，并在已安装 tzdata 时显式收集时区文件。"""

    arguments = [
        str(ROOT / "backend" / "main.py"),
        "--name=multi-agent-backend",
        "--onefile",
        "--clean",
        "--noconfirm",
        f"--paths={ROOT}",
        f"--distpath={OUTPUT_DIRECTORY}",
        f"--workpath={WORK_DIRECTORY}",
        f"--specpath={SPEC_DIRECTORY}",
        "--collect-all=uvicorn",
        "--collect-all=fastapi",
        "--collect-all=pydantic",
        "--hidden-import=uvicorn.logging",
        "--hidden-import=uvicorn.loops.auto",
        "--hidden-import=uvicorn.protocols.http.auto",
        "--hidden-import=uvicorn.protocols.websockets.auto",
        "--hidden-import=uvicorn.lifespan.on",
        "--hidden-import=backend.core._builtin_credentials_generated",
    ]
    if importlib.util.find_spec("tzdata") is not None:
        arguments.extend(["--collect-data=tzdata", "--hidden-import=tzdata"])
    return arguments


def build_executable() -> None:
    """嵌入百炼兜底后，调用 PyInstaller 生成后端可执行文件。"""

    sync_model_catalog()
    embed_builtin_credentials()
    PyInstaller.__main__.run(_pyinstaller_arguments())


def main() -> None:
    """执行清理和构建，并检查最终文件是否存在。"""

    clean_previous_build()
    build_executable()
    candidates = list(OUTPUT_DIRECTORY.glob("multi-agent-backend*"))
    if not candidates:
        raise SystemExit("PyInstaller 没有生成后端可执行文件")
    print(f"Python 后端构建完成：{candidates[0]}")


if __name__ == "__main__":
    main()
