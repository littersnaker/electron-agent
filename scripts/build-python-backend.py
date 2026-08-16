"""使用 PyInstaller 构建可由 Electron 启动的 onedir FastAPI 后端。

onedir 不需要在每次启动时先解压全部 Python 依赖，Windows 安装版的冷启动通常
明显快于 onefile，也更不容易被实时安全扫描拖到启动超时。
"""

from __future__ import annotations

import importlib.util
import shutil
import sys
from pathlib import Path

import PyInstaller.__main__
from embed_builtin_credentials import embed_builtin_credentials

ROOT = Path(__file__).resolve().parents[1]
OUTPUT_DIRECTORY = ROOT / "python-dist"
WORK_DIRECTORY = ROOT / ".python-build"
SPEC_DIRECTORY = ROOT / ".python-spec"

REQUIRED_BUILD_IMPORTS = (
    "fastapi",
    "uvicorn",
    "pydantic",
    "langgraph",
    "PyInstaller",
)


def check_build_environment() -> None:
    """构建前校验解释器，缺模块时直接报错，避免静默产出残缺安装包。"""

    missing = [name for name in REQUIRED_BUILD_IMPORTS if importlib.util.find_spec(name) is None]
    if not missing:
        return
    raise SystemExit(
        "当前 Python 缺少打包所需模块："
        + "、".join(missing)
        + "\n请改用已安装 requirements.txt 与 requirements-dev.txt 的解释器构建，例如：\n"
        + "C:\\Users\\小艳艳的电脑\\AppData\\Local\\Programs\\Python\\Python314\\python.exe scripts\\build-python-backend.py"
    )


def clean_previous_build() -> None:
    """删除旧的 Python 构建产物，避免把过期模块打进安装包。"""

    for directory in (OUTPUT_DIRECTORY, WORK_DIRECTORY, SPEC_DIRECTORY):
        shutil.rmtree(directory, ignore_errors=True)
    OUTPUT_DIRECTORY.mkdir(parents=True, exist_ok=True)


def _pyinstaller_arguments() -> list[str]:
    """生成 PyInstaller 参数，并在已安装 tzdata 时显式收集时区文件。"""

    def collect_optional(package_name: str) -> None:
        """按需收集可选依赖包。

        langgraph 1.x 是 PEP 420 namespace 包（没有顶层 __init__.py），
        PyInstaller 的静态分析经常整包漏掉，必须显式 --collect-all。
        """

        if importlib.util.find_spec(package_name) is not None:
            arguments.extend(
                [
                    f"--collect-all={package_name}",
                    f"--hidden-import={package_name}",
                ]
            )

    arguments = [
        str(ROOT / "backend" / "main.py"),
        "--name=multi-agent-backend",
        "--onedir",
        "--contents-directory=_internal",
        "--noupx",
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
        # 打包后 PROJECT_ROOT 指向 _internal，agent.yaml 与 system skills 必须作为数据文件一并打入。
        f"--add-data={ROOT / 'agents'};agents",
        f"--add-data={ROOT / 'skills' / 'system'};skills/system",
        # 领域规则、市场与命令白名单配置同样需要在运行时读取。
        f"--add-data={ROOT / 'config'};config",
    ]
    collect_optional("langgraph")
    collect_optional("langgraph_sdk")
    collect_optional("langgraph_checkpoint")
    collect_optional("langchain_core")
    # 图片识别 Agent：openpyxl 是函数内延迟导入且带动态子模块，静态分析常整包漏掉，
    # 必须显式收集（与 langgraph 同一原因）；et_xmlfile 是 openpyxl 写文件时依赖的
    # 流式 XML 库，不显式收集会漏进打包产物。PIL 已验证可被自动收集，无需显式处理。
    collect_optional("openpyxl")
    collect_optional("et_xmlfile")
    # OpenCV 带原生 .pyd 扩展，PyInstaller 内置 hook 会收集，但显式收集与
    # langgraph/openpyxl 惯例一致，避免 hook 版本差异导致漏包。
    collect_optional("cv2")
    if importlib.util.find_spec("tzdata") is not None:
        arguments.extend(["--collect-data=tzdata", "--hidden-import=tzdata"])
    return arguments


def build_executable() -> None:
    """嵌入百炼兜底后，调用 PyInstaller 生成后端可执行文件。"""

    embed_builtin_credentials()
    PyInstaller.__main__.run(_pyinstaller_arguments())


def _read_python_version() -> str:
    """从 ``.python-version`` 读取应与 run_code 运行时匹配的 Python 版本。"""

    version_file = ROOT / ".python-version"
    if not version_file.is_file():
        raise SystemExit("缺少 .python-version，无法自动下载 run_code Python 运行时。")
    return version_file.read_text(encoding="utf-8").strip()


def _provision_embedded_python(embedded: Path) -> None:
    """自动下载并解压 Windows embeddable Python 到 ``tools/embed-python/``。

    构建机没有预置运行时且能联网时，直接从 python.org 拉取与 ``.python-version``
    一致的 embed 包，避免其他开发者手动准备；下载/解压失败时给出可读错误，
    并保留手动放置的兜底路径。
    """

    if embedded.is_dir() and (embedded / "python.exe").is_file():
        return
    if sys.platform != "win32":
        raise SystemExit(
            "run_code 运行时仅支持 Windows embeddable Python；"
            f"请在其他系统手动放置 {embedded}/（需含 python.exe）。"
        )

    version = _read_python_version()
    zip_url = f"https://www.python.org/ftp/python/{version}/" f"python-{version}-embed-amd64.zip"
    zip_path = ROOT / "tools" / f"python-{version}-embed-amd64.zip"
    embedded.mkdir(parents=True, exist_ok=True)
    print(f"正在自动下载 Windows embeddable Python {version}：{zip_url}")
    try:
        import urllib.request
        import zipfile

        with urllib.request.urlopen(zip_url, timeout=180) as response:
            with zip_path.open("wb") as output:
                shutil.copyfileobj(response, output)
        with zipfile.ZipFile(zip_path) as archive:
            archive.extractall(embedded)
    except Exception as exc:  # noqa: BLE001 - 构建工具需要把网络失败转成可读提示
        raise SystemExit(
            f"自动下载 run_code 运行时失败（{exc}）。\n"
            f"请手动下载 {zip_url} 并解压到 {embedded}/（需含 python.exe）。"
        ) from exc
    finally:
        zip_path.unlink(missing_ok=True)

    if not (embedded / "python.exe").is_file():
        raise SystemExit(
            f"自动下载完成但缺少 python.exe，请手动把 embeddable python " f"解压到 {embedded}/。"
        )
    print(f"run_code 运行时已就绪：{embedded}")


def prepare_python_runtime() -> Path:
    """准备 run_code 用的独立 Python 运行时（python-dist/python-runtime/）。

    PyInstaller onedir 不含独立 python.exe，run_code 需要在子进程执行模型写的
    程序。这里把 embeddable python（tools/embed-python/）复制过去；目录缺失时
    先尝试自动下载，仍失败才给出明确提示，不静默产出残缺安装包。
    """

    runtime_dir = OUTPUT_DIRECTORY / "python-runtime"
    embedded = ROOT / "tools" / "embed-python"
    if runtime_dir.is_dir():
        return runtime_dir
    _provision_embedded_python(embedded)
    shutil.copytree(embedded, runtime_dir, dirs_exist_ok=True)
    print(f"run_code Python 运行时已就绪：{runtime_dir}")
    return runtime_dir


def main() -> None:
    """执行清理和构建，并检查最终文件是否存在。"""

    check_build_environment()
    clean_previous_build()
    if sys.platform == "win32":
        prepare_python_runtime()
    build_executable()
    bundle_directory = OUTPUT_DIRECTORY / "multi-agent-backend"
    executable_name = (
        "multi-agent-backend.exe" if sys.platform == "win32" else "multi-agent-backend"
    )
    executable = bundle_directory / executable_name
    if not executable.is_file():
        raise SystemExit(f"PyInstaller 没有生成 onedir 后端：{executable}")
    print(f"Python onedir 后端构建完成：{executable}")


if __name__ == "__main__":
    main()
