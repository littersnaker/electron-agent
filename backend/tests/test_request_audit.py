"""请求审计日志模块测试：记录、脱敏、轮转、网关埋点、HTTP 中间件与查询。"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from backend.core import request_audit
from backend.services.llm.catalog import ModelDefinition
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import LlmGateway
from backend.services.llm.types import LlmChunk, LlmMessage, LlmUsage


def _enable_audit(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """开启审计并把日志目录指向临时目录。"""

    audit_dir = tmp_path / "audit"
    monkeypatch.setenv("REQUEST_AUDIT_ENABLED", "1")
    monkeypatch.setenv("REQUEST_AUDIT_DIR", str(audit_dir))
    return audit_dir


def _read_entries(audit_dir: Path) -> list[dict[str, object]]:
    """读取目录下全部 JSON Lines 审计记录。"""

    entries: list[dict[str, object]] = []
    for path in sorted(audit_dir.glob("request-audit-*.jsonl")):
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                line = line.strip()
                if line:
                    entries.append(json.loads(line))
    return entries


def test_record_writes_entry_with_request_id_and_redaction(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audit_dir = _enable_audit(monkeypatch, tmp_path)
    request_id = request_audit.record(
        kind="llm.complete",
        request_id="llm_test_123",
        status="success",
        duration_ms=12,
        request={
            "model": "auto",
            "messages": [{"role": "user", "content": "hi"}],
            "headers": {"Authorization": "Bearer sk-secret123456"},
        },
        response={"text": "ok", "usage": {"total": 3}},
        agent={"agentId": "modify_worker:W001", "sessionId": "s1", "projectId": "p1"},
    )
    assert request_id == "llm_test_123"

    entries = _read_entries(audit_dir)
    assert len(entries) == 1
    entry = entries[0]
    assert entry["requestId"] == "llm_test_123"
    assert entry["kind"] == "llm.complete"
    assert entry["status"] == "success"
    assert entry["durationMs"] == 12
    assert entry["agent"]["agentId"] == "modify_worker:W001"
    assert entry["request"]["headers"]["Authorization"] == "[REDACTED]"
    assert "sk-secret" not in json.dumps(entry, ensure_ascii=False)


def test_recorder_rotates_when_file_exceeds_limit(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audit_dir = _enable_audit(monkeypatch, tmp_path)
    monkeypatch.setenv("REQUEST_AUDIT_MAX_FILE_MB", "0.00001")
    for index in range(5):
        request_audit.record(
            kind="http.request",
            request_id=f"req_{index}",
            status="success",
            duration_ms=1,
            request={"method": "GET", "path": "/x"},
        )
    files = list(audit_dir.glob("request-audit-*.jsonl"))
    assert len(files) >= 2
    entries = _read_entries(audit_dir)
    assert len(entries) == 5


def test_effective_audit_merges_context_and_explicit() -> None:
    token = request_audit.push_audit_context(
        agent_id="coding",
        session_id="s1",
        http_request_id="req_http1",
    )
    try:
        merged = request_audit.effective_audit(
            {"agentRole": "task_planner", "projectId": "p1"}
        )
    finally:
        request_audit.reset_audit_context(token)
    assert merged["agentId"] == "coding"
    assert merged["agentRole"] == "task_planner"
    assert merged["projectId"] == "p1"
    assert merged["httpRequestId"] == "req_http1"


@pytest.mark.asyncio
async def test_gateway_complete_records_success_with_agent_context(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audit_dir = _enable_audit(monkeypatch, tmp_path)
    gateway = LlmGateway()
    model = ModelDefinition(
        id="test:kimi",
        provider="kimi",
        model="kimi-test",
        name="Kimi Test",
        description="测试模型",
        capabilities=("text", "stream"),
    )

    async def fake_stream_model(**_kwargs):
        yield LlmChunk(
            text_delta='{"action":"complete_work"}',
            usage=LlmUsage(prompt=10, completion=5, total=15),
        )

    monkeypatch.setattr(gateway, "resolve_candidates", lambda *_a, **_k: (model,))
    monkeypatch.setattr(gateway, "_stream_model", fake_stream_model)
    monkeypatch.setattr(
        "backend.services.llm.gateway.AVAILABILITY.mark_success",
        lambda *_a, **_k: None,
    )

    token = request_audit.push_audit_context(
        agent_id="modify_worker:W001",
        agent_role="worker_loop",
        session_id="s1",
        project_id="p1",
        http_request_id="req_http1",
    )
    try:
        text, usage, selected = await gateway.complete(
            preferred_model_id=model.id,
            credentials=LlmCredentials(values={}),
            messages=[LlmMessage("user", "完成任务")],
        )
    finally:
        request_audit.reset_audit_context(token)

    assert text == '{"action":"complete_work"}'
    assert usage.total == 15
    assert selected is model
    entries = _read_entries(audit_dir)
    llm_entries = [entry for entry in entries if entry["kind"] == "llm.complete"]
    assert len(llm_entries) == 1
    entry = llm_entries[0]
    assert entry["status"] == "success"
    assert entry["agent"]["agentId"] == "modify_worker:W001"
    assert entry["agent"]["httpRequestId"] == "req_http1"
    assert entry["response"]["usage"]["total"] == 15
    assert entry["request"]["messages"][0]["content"] == "完成任务"


@pytest.mark.asyncio
async def test_gateway_complete_records_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audit_dir = _enable_audit(monkeypatch, tmp_path)
    gateway = LlmGateway()
    model = ModelDefinition(
        id="test:kimi",
        provider="kimi",
        model="kimi-test",
        name="Kimi Test",
        description="测试模型",
        capabilities=("text", "stream"),
    )

    async def failing_stream(**_kwargs):
        yield LlmChunk(text_delta="boom")
        raise RuntimeError("provider exploded")

    monkeypatch.setattr(gateway, "resolve_candidates", lambda *_a, **_k: (model,))
    monkeypatch.setattr(gateway, "_stream_model", failing_stream)

    with pytest.raises(RuntimeError, match="provider exploded"):
        await gateway.complete(
            preferred_model_id=model.id,
            credentials=LlmCredentials(values={}),
            messages=[LlmMessage("user", "x")],
        )
    entries = _read_entries(audit_dir)
    llm_entries = [entry for entry in entries if entry["kind"] == "llm.complete"]
    assert len(llm_entries) == 1
    assert llm_entries[0]["status"] == "error"
    assert "provider exploded" in str(llm_entries[0]["error"])


@pytest.mark.asyncio
async def test_http_middleware_records_request_and_echoes_request_id(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audit_dir = _enable_audit(monkeypatch, tmp_path)

    async def app(scope, receive, send):
        body = b""
        while True:
            message = await receive()
            if message.get("type") != "http.request":
                break
            body += message.get("body", b"")
            if not message.get("more_body", False):
                break
        await send(
            {
                "type": "http.response.start",
                "status": 200,
                "headers": [(b"content-type", b"application/json")],
            }
        )
        await send(
            {"type": "http.response.body", "body": json.dumps({"ok": True}).encode()}
        )

    middleware = request_audit.RequestAuditMiddleware(app)

    async def receive():
        return {"type": "http.request", "body": b'{"messages": []}', "more_body": False}

    sent: list[dict[str, object]] = []

    async def send(message):
        sent.append(message)

    await middleware(
        {
            "type": "http",
            "method": "POST",
            "path": "/api/chat",
            "query_string": b"",
            "headers": [
                (b"content-type", b"application/json"),
                (b"x-agent-id", b"coding"),
            ],
            "client": ("127.0.0.1", 12345),
        },
        receive,
        send,
    )

    entries = _read_entries(audit_dir)
    http_entries = [entry for entry in entries if entry["kind"] == "http.request"]
    assert len(http_entries) == 1
    entry = http_entries[0]
    assert entry["status"] == "success"
    assert entry["request"]["method"] == "POST"
    assert entry["request"]["path"] == "/api/chat"
    assert entry["request"]["body"] == {"messages": []}
    assert entry["response"]["statusCode"] == 200
    assert entry["agent"]["agentId"] == "coding"
    assert entry["agent"]["httpRequestId"] == entry["requestId"]
    start_message = sent[0]
    headers = dict(start_message["headers"])  # type: ignore[arg-type]
    assert headers[b"x-request-id"] == entry["requestId"].encode()


def test_query_filters_by_request_id_agent_and_status(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    audit_dir = _enable_audit(monkeypatch, tmp_path)
    request_audit.record(
        kind="llm.complete",
        request_id="llm_1",
        status="error",
        duration_ms=1,
        request={"model": "a"},
        agent={"agentId": "modify_worker:W001"},
    )
    request_audit.record(
        kind="http.request",
        request_id="req_http9",
        status="success",
        duration_ms=1,
        request={"method": "GET", "path": "/x"},
        agent={"httpRequestId": "req_http9"},
    )

    assert len(request_audit.query(request_id="llm_1", audit_dir=audit_dir)) == 1
    assert len(request_audit.query(agent_id="modify_worker:W001", audit_dir=audit_dir)) == 1
    assert len(request_audit.query(request_id="req_http9", audit_dir=audit_dir)) == 1
    assert len(request_audit.query(status="error", audit_dir=audit_dir)) == 1
    assert request_audit.stats(audit_dir)["entries"] == 2


def test_cli_query(monkeypatch: pytest.MonkeyPatch, tmp_path: Path, capsys) -> None:
    audit_dir = _enable_audit(monkeypatch, tmp_path)
    request_audit.record(
        kind="llm.complete",
        request_id="llm_cli_1",
        status="success",
        duration_ms=1,
        request={"model": "a"},
    )
    exit_code = request_audit.main(
        ["query", "--request-id", "llm_cli_1", "--dir", str(audit_dir)]
    )
    assert exit_code == 0
    assert "llm_cli_1" in capsys.readouterr().out
