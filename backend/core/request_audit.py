"""企业级服务端请求审计日志模块。

按 ``requestId`` 记录所有关键请求（HTTP 入口 + LLM 模型调用），输出为
JSON Lines 文件，默认放在项目根目录 ``request-audit-YYYYMMDD.jsonl``，
并按天 / 大小自动轮转，方便后续问题审核与排查。

特性：

- 每次记录都带 ``requestId``，HTTP 层还会把 ``x-request-id`` 回写到响应头；
- Agent 身份（agentId / sessionId / projectId / traceId）通过上下文自动
  传递，LLM 网关埋点时可拿到“是哪个 Agent 请求的”；
- 请求参数与响应结果结构化保存，敏感字段（API Key、Token、密码等）自动脱敏，
  超长内容自动截断；
- 提供 ``python -m backend.core.request_audit`` 命令行查询工具。

环境变量：

- ``REQUEST_AUDIT_ENABLED``：开关，默认开启（``0`` 关闭）；
- ``REQUEST_AUDIT_DIR``：日志目录，默认项目根目录；
- ``REQUEST_AUDIT_MAX_FILE_MB``：单文件轮转阈值，默认 100MB；
- ``REQUEST_AUDIT_MAX_PAYLOAD_CHARS``：单个字段最大长度，默认 30000；
- ``REQUEST_AUDIT_MAX_MESSAGE_CHARS``：单条 LLM 消息最大长度，默认 8000；
- ``REQUEST_AUDIT_MAX_BODY_CHARS``：HTTP 请求体最大长度，默认 100000。
"""

from __future__ import annotations

import argparse
import contextvars
import dataclasses
import json
import logging
import os
import re
import sys
import tempfile
import threading
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import uuid4

LOGGER = logging.getLogger(__name__)

VERSION = 1

ENV_ENABLED = "REQUEST_AUDIT_ENABLED"
ENV_DIR = "REQUEST_AUDIT_DIR"
ENV_MAX_FILE_MB = "REQUEST_AUDIT_MAX_FILE_MB"
ENV_MAX_PAYLOAD_CHARS = "REQUEST_AUDIT_MAX_PAYLOAD_CHARS"
ENV_MAX_MESSAGE_CHARS = "REQUEST_AUDIT_MAX_MESSAGE_CHARS"
ENV_MAX_BODY_CHARS = "REQUEST_AUDIT_MAX_BODY_CHARS"

DEFAULT_MAX_FILE_MB = 100
DEFAULT_MAX_PAYLOAD_CHARS = 30_000
DEFAULT_MAX_MESSAGE_CHARS = 8_000
DEFAULT_MAX_BODY_CHARS = 100_000

_FILE_PREFIX = "request-audit"

_SENSITIVE_KEY_EXACT = frozenset(
    {
        "api_key",
        "apikey",
        "authorization",
        "proxy_authorization",
        "password",
        "passwd",
        "client_secret",
        "access_token",
        "refresh_token",
        "cookie",
        "set_cookie",
        "x_api_key",
        "x_auth_token",
        "private_key",
        "x_llm_api_key",
    }
)
_SENSITIVE_KEY_SEGMENTS = (
    "apikey",
    "api_key",
    "authorization",
    "password",
    "passwd",
    "secret",
    "credential",
    "cookie",
    "privatekey",
    "accesskey",
    "refreshkey",
)

_SECRET_TEXT_PATTERNS = (
    re.compile(r"(?i)\bsk-[a-z0-9_-]{8,}\b"),
    re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]{12,}"),
    re.compile(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
        re.DOTALL,
    ),
    re.compile(
        r"(?i)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*['\"]?[a-z0-9._/-]{12,}"
    ),
)

_SKIP_PATH_SEGMENTS = (
    "/api/health",
    "/api/docs",
    "/api/openapi.json",
    "/docs",
    "/redoc",
    "/openapi.json",
    "/assets/",
)


def _env_bool(name: str, default: bool) -> bool:
    """读取布尔环境变量，非法值回退默认值。"""

    raw = os.getenv(name, "").strip().lower()
    if not raw:
        return default
    return raw not in {"0", "false", "no", "off", "disabled"}


def _env_float(name: str, default: float) -> float:
    """读取浮点环境变量，非法值回退默认值。"""

    try:
        return float(os.getenv(name, "") or default)
    except (TypeError, ValueError):
        return default


def _env_int(name: str, default: int) -> int:
    """读取整数环境变量，非法值回退默认值。"""

    try:
        return int(os.getenv(name, "") or default)
    except (TypeError, ValueError):
        return default


def _max_payload_chars() -> int:
    """返回单个记录字段的最大长度。"""

    return max(1_000, _env_int(ENV_MAX_PAYLOAD_CHARS, DEFAULT_MAX_PAYLOAD_CHARS))


def _max_message_chars() -> int:
    """返回单条 LLM 消息内容的最大长度。"""

    return max(500, _env_int(ENV_MAX_MESSAGE_CHARS, DEFAULT_MAX_MESSAGE_CHARS))


def _max_body_chars() -> int:
    """返回 HTTP 请求体记录的最大长度。"""

    return max(1_000, _env_int(ENV_MAX_BODY_CHARS, DEFAULT_MAX_BODY_CHARS))


def _default_audit_dir() -> Path:
    """返回审计日志默认目录：开发环境为项目根目录，打包后为可执行文件目录。"""

    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parents[2]


def utc_now_iso() -> str:
    """返回带时区信息的 UTC 时间戳。"""

    return datetime.now(UTC).isoformat()


def new_request_id(prefix: str = "req") -> str:
    """生成唯一请求 ID，例如 ``req_<hex>`` / ``llm_<hex>``。"""

    return f"{prefix}_{uuid4().hex}"


def duration_ms(started: float) -> int:
    """根据单调时钟起始时间计算耗时（毫秒）。"""

    return max(0, int((time.monotonic() - started) * 1000))


def should_skip_path(path: str) -> bool:
    """判断健康检查、文档等噪音路径是否需要跳过审计。"""

    return any(segment in path for segment in _SKIP_PATH_SEGMENTS)


# ---------------------------------------------------------------------------
# 脱敏与截断
# ---------------------------------------------------------------------------


def _normalize_key(key: Any) -> str:
    """把字典键规范化为小写下划线形式，便于匹配敏感字段。"""

    return str(key or "").lower().replace("-", "_").strip()


def _is_sensitive_key(key: Any) -> bool:
    """判断字段名是否属于敏感信息（API Key、Token、密码等）。"""

    normalized = _normalize_key(key)
    if not normalized:
        return False
    if normalized in _SENSITIVE_KEY_EXACT:
        return True
    return any(segment in normalized for segment in _SENSITIVE_KEY_SEGMENTS)


def redact_text(value: str) -> str:
    """把文本中形似密钥的内容替换为占位符。"""

    for pattern in _SECRET_TEXT_PATTERNS:
        value = pattern.sub("[REDACTED]", value)
    return value


def truncate_text(value: str, max_chars: int) -> str:
    """截断超长文本并保留长度提示。"""

    if len(value) <= max_chars:
        return value
    return f"{value[:max_chars]}...[truncated {len(value) - max_chars} chars]"


def _sanitize_value(key: Any, value: Any, max_chars: int) -> Any:
    """递归脱敏 + 截断单个值。"""

    if isinstance(value, dict):
        return {k: _sanitize_value(k, v, max_chars) for k, v in value.items()}
    if isinstance(value, list):
        return [_sanitize_value(key, item, max_chars) for item in value]
    if isinstance(value, str):
        if _is_sensitive_key(key) and len(value.strip()) >= 4:
            return "[REDACTED]"
        return truncate_text(redact_text(value), max_chars)
    return value


def sanitize_payload(
    value: Any, *, max_chars: int | None = None
) -> Any:
    """对请求 / 响应载荷执行统一的脱敏与截断。"""

    return _sanitize_value(None, value, max_chars or _max_payload_chars())


# ---------------------------------------------------------------------------
# 请求上下文（Agent 身份自动传递）
# ---------------------------------------------------------------------------


@dataclasses.dataclass(frozen=True, slots=True)
class AuditContext:
    """一条请求的审计上下文：Agent 身份与关联 ID。"""

    agent_id: str = ""
    agent_role: str = ""
    session_id: str = ""
    project_id: str = ""
    trace_id: str = ""
    http_request_id: str = ""
    parent_request_id: str = ""
    request_id: str = ""


_AUDIT_CONTEXT: contextvars.ContextVar[AuditContext | None] = contextvars.ContextVar(
    "request_audit_context",
    default=None,
)


def get_audit_context() -> AuditContext:
    """返回当前任务继承到的审计上下文（未设置时返回空对象）。"""

    return _AUDIT_CONTEXT.get() or AuditContext()


def push_audit_context(**fields: str) -> contextvars.Token:
    """在当前任务上叠加审计字段，返回用于恢复的 token。"""

    current = get_audit_context()
    data = dataclasses.asdict(current)
    data.update((key, value) for key, value in fields.items() if value)
    return _AUDIT_CONTEXT.set(AuditContext(**data))


def reset_audit_context(token: contextvars.Token) -> None:
    """恢复 push_audit_context 之前的上下文。"""

    _AUDIT_CONTEXT.reset(token)


_FIELD_MAP = {
    "agentId": "agent_id",
    "agentRole": "agent_role",
    "sessionId": "session_id",
    "projectId": "project_id",
    "traceId": "trace_id",
    "httpRequestId": "http_request_id",
    "parentRequestId": "parent_request_id",
    "requestId": "request_id",
}


def effective_audit(explicit: dict[str, Any] | None = None) -> dict[str, str]:
    """合并显式传入与上下文继承的审计字段，显式值优先。"""

    context = get_audit_context()
    result: dict[str, str] = {}
    for field_name, attribute in _FIELD_MAP.items():
        value = (explicit or {}).get(field_name) or getattr(context, attribute) or ""
        result[field_name] = str(value)
    return result


# ---------------------------------------------------------------------------
# 记录器
# ---------------------------------------------------------------------------


class AuditRecorder:
    """线程安全的 JSON Lines 审计记录器，支持按天与按大小轮转。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()

    @property
    def enabled(self) -> bool:
        return _env_bool(ENV_ENABLED, True)

    @property
    def audit_dir(self) -> Path:
        raw = os.getenv(ENV_DIR, "").strip()
        if raw:
            return Path(raw).expanduser().resolve()
        return _default_audit_dir()

    @property
    def max_file_bytes(self) -> int:
        return max(1, int(_env_float(ENV_MAX_FILE_MB, DEFAULT_MAX_FILE_MB) * 1024 * 1024))

    def _target_path(self, directory: Path) -> Path:
        return directory / f"{_FILE_PREFIX}-{datetime.now().strftime('%Y%m%d')}.jsonl"

    def _rotate_path(self, directory: Path) -> Path:
        return directory / f"{_FILE_PREFIX}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.jsonl"

    def write(self, entry: dict[str, Any]) -> str | None:
        """序列化并追加一条记录；失败时只告警，不影响业务。"""

        if not self.enabled:
            return None
        line = json.dumps(entry, ensure_ascii=False, default=str)
        encoded_size = len(line.encode("utf-8")) + 1
        directory = self._resolved_directory()
        if directory is None:
            return None
        with self._lock:
            path = self._target_path(directory)
            try:
                if path.exists() and path.stat().st_size + encoded_size > self.max_file_bytes:
                    path = self._rotate_path(directory)
                with path.open("a", encoding="utf-8", newline="\n") as handle:
                    handle.write(line)
                    handle.write("\n")
            except OSError:
                LOGGER.exception("请求审计日志写入失败: %s", path)
                return None
        return str(entry.get("requestId") or "")

    def _resolved_directory(self) -> Path | None:
        """确定可写目录，首选配置目录，失败时回退临时目录。"""

        candidates: list[Path] = [self.audit_dir]
        data_dir = os.getenv("AGENT_DATA_DIR", "").strip()
        if data_dir:
            candidates.append(Path(data_dir).expanduser().resolve())
        candidates.append(Path(tempfile.gettempdir()) / _FILE_PREFIX)
        for directory in candidates:
            try:
                directory.mkdir(parents=True, exist_ok=True)
                return directory
            except OSError:
                continue
        LOGGER.error("请求审计目录均不可写，已放弃本次记录")
        return None


_RECORDER = AuditRecorder()


def record(
    *,
    kind: str,
    request_id: str,
    status: str,
    duration_ms: int,
    request: dict[str, Any],
    response: dict[str, Any] | None = None,
    agent: dict[str, Any] | None = None,
    error: str | None = None,
    extra: dict[str, Any] | None = None,
) -> str | None:
    """写入一条审计记录，返回 requestId；未开启审计时返回 None。"""

    if not _RECORDER.enabled:
        return None
    entry: dict[str, Any] = {
        "version": VERSION,
        "requestId": request_id,
        "timestamp": utc_now_iso(),
        "kind": kind,
        "status": status,
        "durationMs": max(0, int(duration_ms)),
        "agent": {key: value for key, value in (agent or {}).items() if value},
        "request": sanitize_payload(request),
        "response": sanitize_payload(response or {}),
        "server": {"pid": os.getpid()},
    }
    if error:
        entry["error"] = truncate_text(redact_text(str(error)), 2_000)
    if extra:
        entry["extra"] = sanitize_payload(extra)
    return _RECORDER.write(entry)


# ---------------------------------------------------------------------------
# FastAPI HTTP 请求审计中间件
# ---------------------------------------------------------------------------


def _header_text(value: bytes | None) -> str:
    """把响应头字节值转成字符串，空值返回空串。"""

    if not value:
        return ""
    return value.decode("utf-8", "replace").strip()


async def _collect_body(receive: Any) -> bytes:
    """完整收集请求体字节。"""

    chunks: list[bytes] = []
    while True:
        message = await receive()
        if message.get("type") != "http.request":
            break
        chunks.append(message.get("body") or b"")
        if not message.get("more_body", False):
            break
    return b"".join(chunks)


class RequestAuditMiddleware:
    """记录每个进入 FastAPI 的 HTTP 请求并生成 / 透传 requestId。

    响应会附加 ``x-request-id`` 响应头，方便前端拿到本次请求 ID；
    JSON 请求体会被结构化记录（脱敏 + 截断），响应只记录状态码，
    避免影响 SSE 流式响应。
    """

    def __init__(self, app: Any) -> None:
        self.app = app

    async def __call__(self, scope: dict[str, Any], receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        path = str(scope.get("path") or "")
        if should_skip_path(path):
            await self.app(scope, receive, send)
            return

        headers = {key.lower(): value for key, value in (scope.get("headers") or [])}
        request_id = _header_text(headers.get(b"x-request-id")) or new_request_id("req")
        started = time.monotonic()
        method = str(scope.get("method") or "GET").upper()
        content_type = _header_text(headers.get(b"content-type")).lower()
        query = bytes(scope.get("query_string") or b"").decode("utf-8", "replace")

        # 仅对 JSON / 纯文本请求体做记录，避免缓冲大文件上传。
        replay_body: bytes | None = None
        if content_type.startswith("application/json") or content_type.startswith(
            "text/plain"
        ):
            replay_body = await _collect_body(receive)

        async def audit_receive() -> dict[str, Any]:
            nonlocal replay_body
            # 请求体只重放一次；之后必须透传真实 receive，绝不能伪造
            # http.disconnect，否则 Starlette 的 StreamingResponse 会在流式
            # 输出期间误以为客户端断连而取消整个 SSE 流。
            if replay_body is not None:
                chunk = replay_body
                replay_body = None
                return {"type": "http.request", "body": chunk, "more_body": False}
            return await receive()

        status_code: int | None = None

        async def audit_send(message: dict[str, Any]) -> None:
            nonlocal status_code
            if message.get("type") == "http.response.start":
                status_code = int(message.get("status") or 500)
                header_items = list(message.get("headers") or [])
                header_items.append((b"x-request-id", request_id.encode("utf-8")))
                message["headers"] = header_items
            await send(message)

        request_record: dict[str, Any] = {
            "method": method,
            "path": path,
            "query": query,
            "contentType": content_type or None,
        }
        if replay_body is not None:
            body_text = replay_body.decode("utf-8", "replace")
            try:
                request_record["body"] = json.loads(body_text)
            except (ValueError, TypeError):
                request_record["body"] = truncate_text(body_text, _max_body_chars())

        token = push_audit_context(
            http_request_id=request_id,
            agent_id=_header_text(headers.get(b"x-agent-id")),
            session_id=_header_text(headers.get(b"x-session-id")),
            project_id=_header_text(headers.get(b"x-project-id")),
        )
        try:
            await self.app(scope, audit_receive, audit_send)
        except BaseException as exc:
            LOGGER.exception("RequestAuditMiddleware 捕获异常: %s", type(exc).__name__, exc_info=exc)
            raise
        finally:
            audit_snapshot = effective_audit()
            reset_audit_context(token)
            success = status_code is not None and status_code < 400
            record(
                kind="http.request",
                request_id=request_id,
                status="success" if success else "error",
                duration_ms=duration_ms(started),
                request=request_record,
                response={"statusCode": status_code},
                agent=audit_snapshot,
                error=(
                    None
                    if success
                    else (
                        f"HTTP {status_code}"
                        if status_code is not None
                        else "未处理的服务端异常"
                    )
                ),
                extra=_client_extra(scope, headers),
            )


def _client_extra(scope: dict[str, Any], headers: dict[bytes, bytes]) -> dict[str, Any]:
    """组装客户端来源信息，便于定位请求方。"""

    client = scope.get("client")
    extra: dict[str, Any] = {
        "client": {"host": str(client[0]) if client else ""},
    }
    user_agent = _header_text(headers.get(b"user-agent"))
    if user_agent:
        extra["client"]["userAgent"] = user_agent
    return extra


# ---------------------------------------------------------------------------
# 查询与排查工具
# ---------------------------------------------------------------------------


def iter_entries(
    audit_dir: str | Path | None = None,
) -> Iterator[dict[str, Any]]:
    """按文件时间顺序逐行读取审计记录。"""

    directory = Path(audit_dir) if audit_dir else _RECORDER.audit_dir
    if not directory.is_dir():
        return
    for path in sorted(directory.glob(f"{_FILE_PREFIX}-*.jsonl")):
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line_number, line in enumerate(handle, start=1):
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        yield json.loads(line)
                    except (ValueError, TypeError):
                        LOGGER.warning(
                            "审计日志解析失败: %s 第 %s 行", path, line_number
                        )
        except OSError:
            continue


def query(
    *,
    request_id: str | None = None,
    agent_id: str | None = None,
    kind: str | None = None,
    status: str | None = None,
    limit: int = 50,
    audit_dir: str | Path | None = None,
) -> list[dict[str, Any]]:
    """按 requestId / agent / 类型 / 状态查询审计记录。

    ``request_id`` 同时匹配记录自身的 requestId 和 HTTP 层的
    httpRequestId，方便从任一端发起排查。
    """

    results: list[dict[str, Any]] = []
    for entry in iter_entries(audit_dir):
        agent = entry.get("agent") or {}
        if request_id and entry.get("requestId") != request_id:
            if agent.get("httpRequestId") != request_id:
                continue
        if agent_id and agent.get("agentId", agent.get("id")) != agent_id:
            continue
        if kind and entry.get("kind") != kind:
            continue
        if status and entry.get("status") != status:
            continue
        results.append(entry)
        if len(results) >= limit:
            break
    return results


def stats(audit_dir: str | Path | None = None) -> dict[str, Any]:
    """统计审计日志概览，快速判断故障面。"""

    result: dict[str, Any] = {
        "files": 0,
        "entries": 0,
        "byKind": {},
        "byStatus": {},
    }
    directory = Path(audit_dir) if audit_dir else _RECORDER.audit_dir
    if directory.is_dir():
        result["files"] = len(list(directory.glob(f"{_FILE_PREFIX}-*.jsonl")))
    for entry in iter_entries(audit_dir):
        result["entries"] += 1
        kind = str(entry.get("kind") or "unknown")
        status = str(entry.get("status") or "unknown")
        result["byKind"][kind] = result["byKind"].get(kind, 0) + 1
        result["byStatus"][status] = result["byStatus"].get(status, 0) + 1
    return result


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="request-audit",
        description="查询服务端请求审计日志（默认目录为项目根目录）",
    )
    parent_parser = argparse.ArgumentParser(add_help=False)
    parent_parser.add_argument(
        "--dir",
        default=None,
        help="审计日志目录，默认读取 REQUEST_AUDIT_DIR 或项目根目录",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    query_parser = subparsers.add_parser(
        "query", help="按条件查询请求记录", parents=[parent_parser]
    )
    query_parser.add_argument("--request-id", default=None, help="requestId 或 httpRequestId")
    query_parser.add_argument("--agent", default=None, help="Agent ID，例如 modify_worker:W001")
    query_parser.add_argument("--kind", default=None, help="记录类型，例如 llm.complete / http.request")
    query_parser.add_argument("--status", default=None, help="状态，例如 success / error")
    query_parser.add_argument("--limit", type=int, default=50, help="最大返回条数")

    tail_parser = subparsers.add_parser(
        "tail", help="查看最近记录", parents=[parent_parser]
    )
    tail_parser.add_argument("--limit", type=int, default=20, help="最大返回条数")

    subparsers.add_parser("stats", help="统计概览", parents=[parent_parser])
    return parser


def main(argv: list[str] | None = None) -> int:
    """命令行入口：python -m backend.core.request_audit <query|tail|stats>。"""

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    args = _build_parser().parse_args(argv)
    if args.command == "query":
        entries = query(
            request_id=args.request_id,
            agent_id=args.agent,
            kind=args.kind,
            status=args.status,
            limit=args.limit,
            audit_dir=args.dir,
        )
        print(json.dumps(entries, ensure_ascii=False, indent=2))
    elif args.command == "tail":
        entries = query(limit=args.limit, audit_dir=args.dir)
        print(json.dumps(entries[-args.limit :], ensure_ascii=False, indent=2))
    elif args.command == "stats":
        print(json.dumps(stats(args.dir), ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
