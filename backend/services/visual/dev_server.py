"""受控 dev server 启动通道（视觉验证用）。

与沙箱 A 层的关系：``command_runner.is_high_risk_command`` 拦截 Agent 自动执行
``pnpm dev``/``npm start``（防配置劫持）。视觉验证闭环需要启动项目渲染页面，
因此这里提供**独立受控通道**：只读 ``package.json.scripts.dev`` 并以白名单
包管理器 + dev 脚本的方式启动，不接受任意命令。该通道只由 review 视觉验证
触发，不向 Agent 暴露。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger(__name__)

_DEV_SCRIPT_ALLOWED = "dev"
_PACKAGE_MANAGERS = ("pnpm", "npm", "yarn")
DEV_SERVER_READY_TIMEOUT_SECONDS = 60
DEV_SERVER_POLL_INTERVAL_SECONDS = 0.5


def _load_package_scripts(root: Path) -> dict[str, str]:
    """读取 package.json 的 scripts；缺失或损坏返回空 dict。"""

    package_path = root / "package.json"
    try:
        payload = json.loads(package_path.read_text("utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"无法读取 package.json：{exc}") from exc
    scripts = payload.get("scripts")
    return scripts if isinstance(scripts, dict) else {}


def resolve_dev_command(root: Path, manager: str = "pnpm") -> list[str]:
    """解析并校验 dev 启动命令；非白名单返回空列表。"""

    normalized = (manager or "pnpm").strip().lower()
    if normalized not in _PACKAGE_MANAGERS:
        raise ValueError(f"不支持的包管理器：{manager}")
    scripts = _load_package_scripts(root)
    script = (scripts.get(_DEV_SCRIPT_ALLOWED) or "").strip()
    if not script:
        raise ValueError("项目没有定义 dev 脚本，无法启动预览服务。")
    if any(char in script for char in ("&&", "|", ";", "&", ">")):
        # dev 脚本必须是单条命令，不允许串联/重定向，避免绕过白名单。
        raise ValueError("dev 脚本包含串联或重定向，已拒绝启动。")
    return [normalized, "run", _DEV_SCRIPT_ALLOWED]


async def _wait_for_server_ready(
    port: int,
    *,
    timeout_seconds: float = DEV_SERVER_READY_TIMEOUT_SECONDS,
) -> bool:
    """轮询 localhost 端口直到可连接。"""

    import socket

    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while True:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1.0):
                return True
        except OSError:
            if asyncio.get_running_loop().time() >= deadline:
                return False
            await asyncio.sleep(DEV_SERVER_POLL_INTERVAL_SECONDS)


def _find_free_port() -> int:
    """返回一个空闲的本地端口。"""

    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


async def start_dev_server(
    root: Path,
    *,
    port: int | None = None,
) -> dict[str, Any]:
    """启动项目 dev server，返回进程句柄与访问地址；失败抛 ValueError。"""

    command = resolve_dev_command(root)
    target_port = port or _find_free_port()
    env = os.environ.copy()
    env.update({"CI": "1", "NO_COLOR": "1"})
    # Vite/Webpack 都支持 --port 指定端口；npm 传参走 -- 分隔。
    command = [*command, "--", "--port", str(target_port)] if command[0] == "npm" else [
        *command,
        "--port",
        str(target_port),
    ]
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            cwd=str(root),
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
    except OSError as exc:
        raise ValueError(f"dev server 启动失败：{exc}") from exc

    ready = await _wait_for_server_ready(target_port)
    if not ready:
        # 读取部分输出便于诊断，然后回收进程。
        output = ""
        try:
            output = (await process.stdout.read(2000)).decode("utf-8", errors="replace")  # type: ignore[union-attr]
        except Exception:  # noqa: BLE001
            output = ""
        process.kill()
        await process.wait()
        raise ValueError(
            f"dev server 未在 {DEV_SERVER_READY_TIMEOUT_SECONDS} 秒内就绪。{output[-500:]}"
        )

    LOGGER.info("视觉验证 dev server 已就绪：http://127.0.0.1:%s", target_port)
    return {"process": process, "url": f"http://127.0.0.1:{target_port}", "port": target_port}


async def stop_dev_server(handle: dict[str, Any] | None) -> None:
    """回收 dev server 进程（review 结束时 finally 调用）。"""

    if not handle:
        return
    process = handle.get("process")
    if process and process.returncode is None:
        try:
            process.kill()
            await asyncio.wait_for(process.wait(), timeout=5)
        except (ProcessLookupError, TimeoutError):
            pass


__all__ = ["resolve_dev_command", "start_dev_server", "stop_dev_server"]
