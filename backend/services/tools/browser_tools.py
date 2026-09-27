"""浏览器自动化工具：经 Electron 回环控制服务驱动内置浏览器。

Electron 主进程的 automation-server 在 127.0.0.1 随机端口提供 navigate/extract/
click/fill/screenshot 动作；地址与 token 通过两条通道到达这里：
1. env ``AUTOMATION_HTTP_PORT`` / ``AUTOMATION_HTTP_TOKEN``（Electron spawn 后端时注入）；
2. ``automation-endpoint.json`` 端点文件（dev 模式 concurrently 直启后端的场景）。

端点不可用时返回结构化 ``{"ok": false, "error": ...}`` 而不抛异常（对齐 MCP executor
风格），保证浏览器工具是增强能力，不阻断 Agent 主流程。
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

import httpx

from backend.services.tools.contracts import ToolDefinition, ToolExecutionContext, ToolPermission

LOGGER = logging.getLogger(__name__)

ENDPOINT_FILE_NAME = "automation-endpoint.json"
NAVIGATE_TIMEOUT_SECONDS = 60.0
ACTION_TIMEOUT_SECONDS = 30.0
# 端点文件很小且低频读取；按 mtime 缓存避免每次工具调用都做磁盘 IO。
_ENDPOINT_CACHE: dict[str, tuple[float, dict[str, Any] | None]] = {}


def browser_tools_enabled() -> bool:
    """全局开关：CODE_AGENT 是否向模型暴露 browser.* 工具（默认开）。"""

    return os.getenv("BROWSER_TOOLS_ENABLED", "1").strip().lower() in {"1", "true", "yes", "on"}


def browser_tool_approval_enabled() -> bool:
    """审批门开关：任务内首次使用浏览器是否需要用户批准（默认开）。"""

    return os.getenv("BROWSER_TOOL_APPROVAL", "1").strip().lower() in {"1", "true", "yes", "on"}


def _candidate_endpoint_files() -> list[Path]:
    """按优先级返回端点文件的候选路径。"""

    from backend.core.config import get_settings

    candidates = [get_settings().data_dir / ENDPOINT_FILE_NAME]
    # Electron 稳定数据目录（app.getPath("appData")/Multi-agent）的跨平台镜像，
    # 覆盖打包模式下端点文件兜底的场景。
    home = Path.home()
    if sys.platform == "darwin":
        candidates.append(
            home / "Library" / "Application Support" / "Multi-agent" / ENDPOINT_FILE_NAME
        )
    elif sys.platform == "win32":
        appdata = os.getenv("APPDATA")
        if appdata:
            candidates.append(Path(appdata) / "Multi-agent" / ENDPOINT_FILE_NAME)
    else:
        candidates.append(home / ".config" / "Multi-agent" / ENDPOINT_FILE_NAME)
    return candidates


def _read_endpoint_file(path: Path) -> dict[str, Any] | None:
    """按 mtime 缓存读取端点文件；文件缺失或损坏返回 None。"""

    try:
        mtime = path.stat().st_mtime
    except OSError:
        _ENDPOINT_CACHE.pop(str(path), None)
        return None
    cached = _ENDPOINT_CACHE.get(str(path))
    if cached and cached[0] == mtime:
        return cached[1]
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        _ENDPOINT_CACHE[str(path)] = (mtime, None)
        return None
    endpoint = (
        payload
        if isinstance(payload, dict) and payload.get("port") and payload.get("token")
        else None
    )
    _ENDPOINT_CACHE[str(path)] = (mtime, endpoint)
    return endpoint


def resolve_automation_endpoint() -> tuple[str, str] | None:
    """解析自动化控制端点（base_url, token）；不可用时返回 None。"""

    port = os.getenv("AUTOMATION_HTTP_PORT", "").strip()
    token = os.getenv("AUTOMATION_HTTP_TOKEN", "").strip()
    if port.isdigit() and token:
        return f"http://127.0.0.1:{port}", token

    for candidate in _candidate_endpoint_files():
        endpoint = _read_endpoint_file(candidate)
        if not endpoint:
            continue
        file_port = str(endpoint.get("port") or "")
        file_token = str(endpoint.get("token") or "")
        # 端点文件里带 pid：Electron 退出重启后旧文件会因 pid 变化被判失效，
        # 避免把请求发到不复存的端口上。
        file_pid = str(endpoint.get("pid") or "")
        if (
            file_pid
            and file_pid != str(os.getpid())
            and not _pid_alive(int(file_pid) if file_pid.isdigit() else 0)
        ):
            continue
        if file_port.isdigit() and file_token:
            return f"http://127.0.0.1:{file_port}", file_token
    return None


def _pid_alive(pid: int) -> bool:
    """检查持有端点的 Electron 进程是否仍然存活（pid 不匹配时兜底）。"""

    if pid <= 0:
        return True
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


async def _post_action(
    action: str,
    payload: dict[str, Any],
    *,
    timeout: float,
) -> dict[str, Any]:
    """调用 Electron 自动化端点的单个动作；网络/协议错误归一为 {ok:false}。"""

    endpoint = resolve_automation_endpoint()
    if endpoint is None:
        return {
            "ok": False,
            "error": "桌面自动化端点不可用（需要在桌面应用中运行，且应用已完全启动）",
        }
    base_url, token = endpoint
    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{base_url}/{action}",
                json=payload,
                headers={"Authorization": f"Bearer {token}"},
            )
    except (httpx.TimeoutException, httpx.NetworkError) as exc:
        return {"ok": False, "error": f"连接自动化服务失败：{exc}"}
    try:
        result = response.json()
    except ValueError:
        return {"ok": False, "error": f"自动化服务返回非 JSON 响应（HTTP {response.status_code}）"}
    return result if isinstance(result, dict) else {"ok": False, "error": "自动化服务返回格式异常"}


def _require_enabled() -> str | None:
    """工具被 env 关闭时的统一提示。"""

    if not browser_tools_enabled():
        return "浏览器自动化已通过 BROWSER_TOOLS_ENABLED=0 关闭"
    return None


async def _navigate(context: ToolExecutionContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """打开 URL 并返回页面标题与正文文本预览。"""

    disabled = _require_enabled()
    if disabled:
        return {"ok": False, "error": disabled}
    url = str(arguments.get("url") or "").strip()
    if not url:
        return {"ok": False, "error": "缺少 url 参数"}
    return await _post_action("navigate", {"url": url}, timeout=NAVIGATE_TIMEOUT_SECONDS)


async def _extract(context: ToolExecutionContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """抽取页面或指定元素的可见文本。"""

    disabled = _require_enabled()
    if disabled:
        return {"ok": False, "error": disabled}
    selector = str(arguments.get("selector") or "").strip()
    return await _post_action("extract", {"selector": selector}, timeout=ACTION_TIMEOUT_SECONDS)


async def _click(context: ToolExecutionContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """按 CSS 选择器或可见文本点击页面元素。"""

    disabled = _require_enabled()
    if disabled:
        return {"ok": False, "error": disabled}
    selector = str(arguments.get("selector") or "").strip()
    text = str(arguments.get("text") or "").strip()
    if not selector and not text:
        return {"ok": False, "error": "必须提供 selector 或 text 之一"}
    return await _post_action(
        "click", {"selector": selector, "text": text}, timeout=ACTION_TIMEOUT_SECONDS
    )


async def _fill(context: ToolExecutionContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """向输入框写入文本（兼容 React 受控组件）。"""

    disabled = _require_enabled()
    if disabled:
        return {"ok": False, "error": disabled}
    selector = str(arguments.get("selector") or "").strip()
    value = str(arguments.get("value") or "")
    if not selector:
        return {"ok": False, "error": "缺少 selector 参数"}
    return await _post_action(
        "fill", {"selector": selector, "value": value}, timeout=ACTION_TIMEOUT_SECONDS
    )


async def _screenshot(context: ToolExecutionContext, arguments: dict[str, Any]) -> dict[str, Any]:
    """截取当前页面（降采样 JPEG base64）。"""

    disabled = _require_enabled()
    if disabled:
        return {"ok": False, "error": disabled}
    return await _post_action("screenshot", {}, timeout=ACTION_TIMEOUT_SECONDS)


TOOL_DEFINITIONS: tuple[ToolDefinition, ...] = (
    ToolDefinition(
        "browser.navigate",
        "在内置浏览器中打开网页并返回标题与正文预览",
        "control",
        _navigate,
        90.0,
        1,
    ),
    ToolDefinition(
        "browser.extract",
        "抽取内置浏览器当前页面或指定元素的可见文本",
        "control",
        _extract,
        45.0,
        1,
    ),
    ToolDefinition(
        "browser.click",
        "点击内置浏览器页面元素（CSS 选择器或可见文本匹配）",
        "control",
        _click,
        45.0,
        0,
    ),
    ToolDefinition(
        "browser.fill",
        "向内置浏览器页面的输入框写入文本",
        "control",
        _fill,
        45.0,
        0,
    ),
    ToolDefinition(
        "browser.screenshot",
        "截取内置浏览器当前页面并返回 JPEG base64",
        "control",
        _screenshot,
        45.0,
        1,
    ),
)

_REGISTERED = False

_TOOL_PERMISSIONS: dict[str, ToolPermission] = {
    definition.name: definition.permission for definition in TOOL_DEFINITIONS
}


def browser_tool_permission(name: str) -> ToolPermission:
    """返回 browser.* 工具对应的权限（供调用方传 allowed_permissions）。"""

    return _TOOL_PERMISSIONS.get(name, "control")


def register_browser_tools() -> None:
    """幂等注册浏览器自动化工具（与基础工具共享同一 Gateway）。"""

    global _REGISTERED
    if _REGISTERED:
        return
    from backend.services.tools.gateway import TOOL_GATEWAY

    for definition in TOOL_DEFINITIONS:
        TOOL_GATEWAY.register(definition)
    _REGISTERED = True
