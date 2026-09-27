"""浏览器自动化工具与审批门测试（端点用本地假服务，不依赖 Electron）。"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from backend.services.agent.shared.loop_protocol import AgentAction
from backend.services.agent.shared.work_state import WorkWorkerState
from backend.services.tools.browser_tools import (
    register_browser_tools,
    resolve_automation_endpoint,
)
from backend.services.tools.code_tools import execute_code_tool

# ---------------------------- 端点解析 ----------------------------


def test_resolve_endpoint_from_env(monkeypatch, tmp_path: Path) -> None:
    """env 注入（打包 spawn 模式）优先于端点文件。"""

    monkeypatch.setenv("AUTOMATION_HTTP_PORT", "45678")
    monkeypatch.setenv("AUTOMATION_HTTP_TOKEN", "tok-env")
    monkeypatch.chdir(tmp_path)
    from backend.core.config import get_settings

    get_settings.cache_clear()
    try:
        assert resolve_automation_endpoint() == ("http://127.0.0.1:45678", "tok-env")
    finally:
        get_settings.cache_clear()


def test_resolve_endpoint_from_file(monkeypatch, tmp_path: Path) -> None:
    """dev 模式：端点文件落在数据目录（项目根），按 pid 存活校验后可用。"""

    import os

    monkeypatch.delenv("AUTOMATION_HTTP_PORT", raising=False)
    monkeypatch.delenv("AUTOMATION_HTTP_TOKEN", raising=False)
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("MULTI_AGENT_TEST_PID", str(os.getpid()))
    from backend.core.config import get_settings

    get_settings.cache_clear()
    endpoint_file = tmp_path / "automation-endpoint.json"
    endpoint_file.write_text(
        json.dumps({"port": 45679, "token": "tok-file", "pid": os.getpid()}),
        encoding="utf-8",
    )
    try:
        assert resolve_automation_endpoint() == ("http://127.0.0.1:45679", "tok-file")
    finally:
        get_settings.cache_clear()


def test_resolve_endpoint_none_when_absent(monkeypatch, tmp_path: Path) -> None:
    """env 与端点文件都缺失时返回 None（工具据此降级）。"""

    monkeypatch.delenv("AUTOMATION_HTTP_PORT", raising=False)
    monkeypatch.delenv("AUTOMATION_HTTP_TOKEN", raising=False)
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "missing"))
    (tmp_path / "missing").mkdir(parents=True, exist_ok=True)
    monkeypatch.chdir(tmp_path / "missing")
    from backend.core.config import get_settings

    get_settings.cache_clear()
    try:
        assert resolve_automation_endpoint() is None
    finally:
        get_settings.cache_clear()


# ---------------------------- 工具执行 ----------------------------


class _FakeAutomationServer:
    """本地假自动化服务：记录请求并返回固定响应，校验 Bearer 头。"""

    def __init__(self) -> None:
        self.requests: list[tuple[str, dict[str, object], str]] = []
        self.response: dict[str, object] = {"ok": True, "text": "页面内容"}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802 - http.server 命名约定
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}") if length else {}
                outer.requests.append((self.path, body, self.headers.get("Authorization") or ""))
                payload = json.dumps(outer.response).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args: object) -> None:
                return None

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()
        self.port = self._server.server_address[1]

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()


@pytest.mark.asyncio
async def test_tools_send_bearer_and_passthrough(monkeypatch, tmp_path: Path) -> None:
    """工具经 Tool Gateway 调用假端点：Bearer 头携带 token，响应透传。"""

    fake = _FakeAutomationServer()
    monkeypatch.setenv("AUTOMATION_HTTP_PORT", str(fake.port))
    monkeypatch.setenv("AUTOMATION_HTTP_TOKEN", "secret-token")
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from backend.core.config import get_settings

    get_settings.cache_clear()
    register_browser_tools()
    try:
        result = await execute_code_tool(
            "browser.navigate",
            root=tmp_path,
            arguments={"url": "http://127.0.0.1:5173/"},
            permissions={"control"},
            agent_id="test-worker",
        )
        assert result["ok"] is True
        assert result["text"] == "页面内容"
        path, body, authorization = fake.requests[0]
        assert path == "/navigate"
        assert body["url"] == "http://127.0.0.1:5173/"
        assert authorization == "Bearer secret-token"
    finally:
        fake.stop()
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_tools_degrade_without_endpoint(monkeypatch, tmp_path: Path) -> None:
    """端点不可用时返回结构化 {ok:false}，不抛异常。"""

    monkeypatch.delenv("AUTOMATION_HTTP_PORT", raising=False)
    monkeypatch.delenv("AUTOMATION_HTTP_TOKEN", raising=False)
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "missing"))
    monkeypatch.chdir(tmp_path)
    from backend.core.config import get_settings

    get_settings.cache_clear()
    try:
        result = await execute_code_tool(
            "browser.extract",
            root=tmp_path,
            arguments={},
            permissions={"control"},
            agent_id="test-worker",
        )
        assert result["ok"] is False
        assert "端点不可用" in result["error"]
    finally:
        get_settings.cache_clear()


@pytest.mark.asyncio
async def test_click_requires_selector_or_text(tmp_path: Path) -> None:
    """click 缺少 selector 与 text 时在工具侧直接拒绝。"""

    result = await execute_code_tool(
        "browser.click",
        root=tmp_path,
        arguments={},
        permissions={"control"},
        agent_id="test-worker",
    )
    assert result["ok"] is False
    assert "selector" in result["error"] or "text" in result["error"]


# ---------------------------- 审批门 ----------------------------


def _make_handler(tmp_path: Path, work_id: str = "W-BROWSER"):
    """构造带事件捕获的测试 Handler（复用现有测试的构造方式）。"""

    from backend.services.agent.shared.resource_coordinator import WorkspaceResourceCoordinator
    from backend.services.agent.shared.work_models import WorkItem
    from backend.services.agent.worker.work_action_handler import (
        WorkActionEnvironment,
        WorkActionHandler,
    )

    captured: list[tuple[str, dict[str, object]]] = []

    async def capture_emit(kind: str, payload: dict[str, object]) -> None:
        captured.append((kind, payload))

    async def noop_checkpoint() -> None:
        return None

    work = WorkItem(work_id, f"{work_id} 标题", "打开页面验证", target_files=[])
    handler = WorkActionHandler(
        WorkActionEnvironment(
            root=tmp_path,
            request_text="测试",
            work=work,
            state=WorkWorkerState(),
            execution_mode="full_auto",
            coordinator=WorkspaceResourceCoordinator(),
            emit=capture_emit,
            checkpoint=noop_checkpoint,
            slot=1,
            agent_id=f"test-worker:{work_id}",
        )
    )
    return handler, captured


def _browser_action(tool: str = "navigate", **arguments: object) -> AgentAction:
    return AgentAction(action="browser", tool=tool, arguments=arguments)


@pytest.mark.asyncio
async def test_first_browser_action_pauses_for_approval(monkeypatch, tmp_path: Path) -> None:
    """任务内首次浏览器动作：不发请求，先落审批卡片并暂停。"""

    from backend.services.workspace.database import initialize_database

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.delenv("BROWSER_TOOL_APPROVAL", raising=False)
    from backend.core.config import get_settings

    get_settings.cache_clear()
    await initialize_database()
    handler, captured = _make_handler(tmp_path)

    outcome = await handler.execute(_browser_action("navigate", url="http://127.0.0.1:5173/"))
    assert outcome.kind == "pause"
    kinds = [kind for kind, _payload in captured]
    assert "interactive" in kinds
    card = next(payload for kind, payload in captured if kind == "interactive")
    assert card["approvalKind"] == "browser_run"
    assert card["options"][0]["value"] == "approve"
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_approved_browser_action_executes(monkeypatch, tmp_path: Path) -> None:
    """用户批准后：后续浏览器动作免批直接执行并写入观察。"""

    from backend.services.agent.worker.pending import (
        find_pending_command,
        resolve_pending_command,
    )
    from backend.services.workspace.database import initialize_database

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    from backend.core.config import get_settings

    get_settings.cache_clear()
    await initialize_database()
    handler, captured = _make_handler(tmp_path)

    first = await handler.execute(_browser_action("navigate", url="http://x.test"))
    assert first.kind == "pause"
    record = await find_pending_command("W-BROWSER")
    assert record is not None
    await resolve_pending_command(str(record["requestId"]), approved=True)

    executed: list[tuple[str, dict[str, object]]] = []

    async def fake_execute_code_tool(name: str, **kwargs: object):
        executed.append((name, dict(kwargs.get("arguments") or {})))
        return {"ok": True, "text": "标题：演示页"}

    monkeypatch.setattr(
        "backend.services.agent.worker.work_action_handler.execute_code_tool",
        fake_execute_code_tool,
    )
    second = await handler.execute(_browser_action("extract"))
    assert second.kind == "continue"
    assert executed and executed[0][0] == "browser.extract"
    assert "OBSERVATION" in handler._env.state.transcript[-1]
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_rejected_browser_action_fails_without_executing(monkeypatch, tmp_path: Path) -> None:
    """用户拒绝后：同一任务内的浏览器动作直接失败，不再执行也不再询问。"""

    from backend.services.agent.worker.pending import (
        find_pending_command,
        resolve_pending_command,
    )
    from backend.services.workspace.database import initialize_database

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    from backend.core.config import get_settings

    get_settings.cache_clear()
    await initialize_database()
    handler, captured = _make_handler(tmp_path)

    first = await handler.execute(_browser_action("navigate", url="http://x.test"))
    assert first.kind == "pause"
    record = await find_pending_command("W-BROWSER")
    await resolve_pending_command(str(record["requestId"]), approved=False)

    executed: list[str] = []

    async def fake_execute_code_tool(name: str, **kwargs: object):
        executed.append(name)
        return {"ok": True}

    monkeypatch.setattr(
        "backend.services.agent.worker.work_action_handler.execute_code_tool",
        fake_execute_code_tool,
    )
    second = await handler.execute(_browser_action("navigate", url="http://x.test"))
    assert second.kind == "failure"
    assert executed == []
    get_settings.cache_clear()


@pytest.mark.asyncio
async def test_browser_disabled_by_env(monkeypatch, tmp_path: Path) -> None:
    """BROWSER_TOOLS_ENABLED=0 时动作直接失败，不触发审批。"""

    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("BROWSER_TOOLS_ENABLED", "0")
    from backend.core.config import get_settings
    from backend.services.workspace.database import initialize_database

    get_settings.cache_clear()
    await initialize_database()
    handler, captured = _make_handler(tmp_path)

    outcome = await handler.execute(_browser_action("navigate", url="http://x.test"))
    assert outcome.kind == "failure"
    assert all(kind != "interactive" for kind, _payload in captured)
    get_settings.cache_clear()


# ---------------------------- browser.look（视觉观察） ----------------------------


@pytest.mark.asyncio
async def test_look_sends_screenshot_to_gateway(monkeypatch, tmp_path: Path) -> None:
    """look 截图后把图像交给视觉模型，返回文字结论；凭证来自 metadata。"""

    from backend.services.llm.credentials import LlmCredentials
    from backend.services.llm.types import LlmUsage

    fake = _FakeAutomationServer()
    fake.response = {
        "ok": True,
        "imageBase64": "aW1hZ2VfZGF0YQ==",
        "mimeType": "image/jpeg",
        "width": 1280,
        "height": 800,
    }
    monkeypatch.setenv("AUTOMATION_HTTP_PORT", str(fake.port))
    monkeypatch.setenv("AUTOMATION_HTTP_TOKEN", "tok")
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from backend.core.config import get_settings

    get_settings.cache_clear()
    register_browser_tools()

    calls: list[dict[str, object]] = []

    class _StubGateway:
        async def complete(self, **kwargs: object):
            calls.append(dict(kwargs))
            return (
                "页面显示登录表单",
                LlmUsage(prompt=500, completion=30, total=530),
                type("M", (), {"model": "deepseek-v4-flash-vision-exp"})(),
            )

    monkeypatch.setattr("backend.services.llm.gateway.GATEWAY", _StubGateway())

    credentials = LlmCredentials(values={})
    try:
        result = await execute_code_tool(
            "browser.look",
            root=tmp_path,
            arguments={"goal": "确认登录表单状态"},
            permissions={"control"},
            agent_id="test-worker",
            metadata={"credentials": credentials},
        )
    finally:
        fake.stop()
        get_settings.cache_clear()

    assert result["ok"] is True
    assert "登录表单" in result["content"]
    call = calls[0]
    message = call["messages"][0]
    assert "确认登录表单状态" in message.content
    assert message.images[0].data == "aW1hZ2VfZGF0YQ=="
    assert message.images[0].mime_type == "image/jpeg"
    # 截图请求发往自动化端点（一次 screenshot 调用）。
    assert fake.requests[0][0] == "/screenshot"


@pytest.mark.asyncio
async def test_look_requires_credentials_metadata(monkeypatch, tmp_path: Path) -> None:
    """metadata 缺凭证（模型不可注入）时 look 返回结构化错误。"""

    monkeypatch.setenv("AUTOMATION_HTTP_PORT", "45678")
    monkeypatch.setenv("AUTOMATION_HTTP_TOKEN", "tok")
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from backend.core.config import get_settings

    get_settings.cache_clear()
    register_browser_tools()
    try:
        result = await execute_code_tool(
            "browser.look",
            root=tmp_path,
            arguments={},
            permissions={"control"},
            agent_id="test-worker",
        )
    finally:
        get_settings.cache_clear()
    assert result["ok"] is False
    assert "凭证" in result["error"]


@pytest.mark.asyncio
async def test_look_appends_vision_model_hint(monkeypatch, tmp_path: Path) -> None:
    """视觉模型缺失的报错应附加配置引导。"""

    fake = _FakeAutomationServer()
    fake.response = {"ok": True, "imageBase64": "aW1hZ2U=", "mimeType": "image/jpeg"}
    monkeypatch.setenv("AUTOMATION_HTTP_PORT", str(fake.port))
    monkeypatch.setenv("AUTOMATION_HTTP_TOKEN", "tok")
    monkeypatch.setenv("AGENT_DATA_DIR", str(tmp_path))
    from backend.core.config import get_settings
    from backend.services.llm.credentials import LlmCredentials

    get_settings.cache_clear()
    register_browser_tools()

    class _NoVisionGateway:
        async def complete(self, **kwargs: object):
            raise ValueError("已配置的模型均不支持图像输入，请配置或选择支持 Vision 的模型。")

    monkeypatch.setattr("backend.services.llm.gateway.GATEWAY", _NoVisionGateway())

    credentials = LlmCredentials(values={})
    try:
        result = await execute_code_tool(
            "browser.look",
            root=tmp_path,
            arguments={},
            permissions={"control"},
            agent_id="test-worker",
            metadata={"credentials": credentials},
        )
    finally:
        fake.stop()
        get_settings.cache_clear()

    assert result["ok"] is False
    assert "deepseek-v4-flash-vision-exp" in result["error"]
