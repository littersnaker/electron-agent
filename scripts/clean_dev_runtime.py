"""清理本地开发缓存，并阻止开发命令连接到旧服务进程。"""

from __future__ import annotations

import shutil
import socket
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEVELOPMENT_PORTS = (5173, 3100)
CACHE_DIRECTORIES = (
    ROOT / ".electron",
    ROOT / "dist",
    ROOT / ".pytest_cache",
    ROOT / ".dev-runtime",
    ROOT / "node_modules" / ".vite",
    ROOT / "node_modules" / ".cache",
)


def _remove_directory(path: Path) -> None:
    """递归删除一个开发构建或缓存目录。"""

    if not path.exists():
        return
    shutil.rmtree(path, ignore_errors=True)
    print(f"[开发清理] 已删除：{path.relative_to(ROOT)}")


def _remove_python_cache() -> None:
    """删除源码目录中的 pycache/pyc，避免开发者误判正在执行旧模块。"""

    for source_root in (ROOT / "backend", ROOT / "scripts"):
        for directory in source_root.rglob("__pycache__"):
            if directory.is_dir():
                shutil.rmtree(directory, ignore_errors=True)
        for file in source_root.rglob("*.pyc"):
            file.unlink(missing_ok=True)
    print("[开发清理] 已删除 Python 字节码缓存")


def _port_is_open(port: int) -> bool:
    """判断本机开发端口是否已经被旧进程占用。"""

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(0.25)
        return client.connect_ex(("127.0.0.1", port)) == 0


def _assert_ports_are_free() -> None:
    """端口被占用时直接失败，绝不静默复用旧 Vite 或旧 Python。"""

    occupied = [port for port in DEVELOPMENT_PORTS if _port_is_open(port)]
    if not occupied:
        return
    ports = ", ".join(str(port) for port in occupied)
    raise SystemExit(
        "检测到旧的本地开发进程仍在运行，已停止启动，避免吃旧代码。\n"
        f"被占用端口：{ports}\n"
        "请先退出旧 Electron/终端；Windows 可执行：\n"
        f"  netstat -ano | findstr :{occupied[0]}\n"
        "找到 PID 后执行：taskkill /PID <PID> /T /F"
    )


def main() -> None:
    """清理缓存并确认新开发服务可以独占固定端口。"""

    for directory in CACHE_DIRECTORIES:
        _remove_directory(directory)
    _remove_python_cache()
    _assert_ports_are_free()
    print("[开发清理] 完成；本次运行不会回退到旧 dist 或旧后端进程")


if __name__ == "__main__":
    main()
