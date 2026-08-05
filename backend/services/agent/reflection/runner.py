"""复盘执行器：门控 → 摘要 → 提取 → 校验过滤 → 去重/容量 → SQLite 写入。

支持两类触发：
- Code Agent：每个 Work 完成/失败后（schedule_work_review）；
- 跨境电商 Agent：统一 Runtime 任务完成/失败后（schedule_runtime_review）。
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from backend.core import request_audit
from backend.services.agent.reflection.digest import (
    build_runtime_digest,
    build_work_digest,
)
from backend.services.agent.reflection.schema import (
    filter_review_output,
    parse_review_output,
    review_output_has_content,
)
from backend.services.agent.reflection.settings import (
    read_review_settings,
    resolve_review_model,
)
from backend.services.agent.reflection.store import (
    digest_hash,
    enforce_semantic_capacity,
    find_duplicate_review,
    record_review_artifact,
    write_semantic_knowledge,
)
from backend.services.llm.credentials import LlmCredentials
from backend.services.llm.gateway import GATEWAY
from backend.services.llm.types import LlmMessage

LOGGER = logging.getLogger(__name__)

_REVIEW_SEMAPHORE = asyncio.Semaphore(1)
_INFLIGHT: set[str] = set()

_SYSTEM_PROMPT = """你是一个 Agent 学习复盘器。你的任务是从一段执行记录中提取"以后还能复用"的知识，
而不是复述这次任务。只返回一个 JSON 对象，禁止 Markdown 围栏与前后解释。"""

_USER_TEMPLATE = """请复盘下面这段 Agent 执行记录，提取可复用的知识。

输出结构（全部字段可选，拿不准就返回空数组）：
{
  "facts": [{"content": "可复用的项目/业务事实", "scope": "project|business", "confidence": "high|medium|low"}],
  "lessons": [{"content": "经验教训", "trigger": "什么场景会用到", "confidence": "high|medium|low"}],
  "skill_updates": [{"action": "create|patch", "name": "技能名", "diff_summary": "具体流程变更", "evidence": "证据来源"}],
  "risks": ["需要注意的风险"]
}

规则：
- facts 只存以后还用得上的事实（路径、约定、平台规则、架构决策），不存一次性细节；
- lessons 要带 trigger，说明什么场景会踩这个坑；
- skill_updates 只有当本次执行沉淀出了可复用的操作流程时才写，diff_summary 必须具体；
- confidence=low 的内容会被直接丢弃，拿不准就标 low 或干脆不写；
- 严禁编造执行记录里没有的信息。

执行记录：
{digest}
"""

_COMMERCE_SYSTEM_PROMPT = """你是一个跨境电商 Agent 的业务复盘器。你的任务是从一次业务执行记录中
提取"以后还能复用"的业务知识：平台规则、API 行为、运营约束、异常模式、数据源特性。
禁止复述本次任务本身。只返回一个 JSON 对象，禁止 Markdown 围栏与前后解释。"""

_COMMERCE_USER_TEMPLATE = """请复盘下面这段跨境电商 Agent 执行记录，提取可复用的业务知识。

输出结构（全部字段可选，拿不准就返回空数组）：
{
  "facts": [{"content": "可复用的业务事实（平台规则/API 行为/数据源特性）", "scope": "business", "confidence": "high|medium|low"}],
  "lessons": [{"content": "运营/对接经验教训", "trigger": "什么业务场景会用到", "confidence": "high|medium|low"}],
  "skill_updates": [{"action": "create|patch", "name": "运营/对接技能名", "diff_summary": "具体流程变更", "evidence": "证据来源"}],
  "risks": ["需要注意的业务风险"]
}

规则：
- 只提取跨任务可复用的模式（例如某平台 API 的限流行为、某数据源的字段缺失规律、某类异常的处理路径）；
- 不记录一次性订单、客户、价格等具体业务数据（记录里已经过脱敏，不要自行补充）；
- confidence=low 的内容会被直接丢弃；严禁编造记录里没有的信息。

执行记录：
{digest}
"""


async def _write_knowledge(
    *,
    output: Any,
    scope_id: str,
    task_id: str,
) -> int:
    """把过滤后的 facts/lessons 写入 semantic 记忆，返回实际写入条数。"""

    written = 0
    for fact in output.facts:
        if await write_semantic_knowledge(
            scope_id=scope_id,
            kind="fact",
            content=fact.content,
            work_id=task_id,
            confidence=fact.confidence,
        ):
            written += 1
    for lesson in output.lessons:
        if await write_semantic_knowledge(
            scope_id=scope_id,
            kind="lesson",
            content=lesson.content,
            work_id=task_id,
            confidence=lesson.confidence,
            trigger=lesson.trigger,
        ):
            written += 1
    return written


async def _review_common(
    *,
    task_id: str,
    agent_kind: str,
    scope_id: str,
    digest: str,
    credentials: LlmCredentials,
    model: Any,
    system_prompt: str,
    user_template: str,
    default_status: str,
) -> None:
    """共享复盘管线：去重 → LLM 提取 → 校验过滤 → 写入/审批。"""

    digest_fingerprint = digest_hash(digest)
    duplicate = await find_duplicate_review(
        work_id=task_id,
        digest_hash_value=digest_fingerprint,
    )
    if duplicate is not None:
        LOGGER.info("复盘已处理过，跳过（task=%s）", task_id)
        return

    async with _REVIEW_SEMAPHORE:
        try:
            text, _usage, _model = await GATEWAY.complete(
                preferred_model_id=model.id,
                credentials=credentials,
                messages=[
                    LlmMessage("system", system_prompt),
                    LlmMessage(
                        "user",
                        user_template.replace("{digest}", digest[:24_000]),
                    ),
                ],
                temperature=0.1,
                timeout_seconds=120,
                stall_timeout_seconds=60,
                audit={
                    "agentId": f"reflection:{agent_kind}:{task_id}",
                    "agentRole": "reflection",
                    "parentRequestId": task_id,
                },
            )
        except Exception as exc:
            LOGGER.warning("复盘模型调用失败，丢弃（task=%s）：%s", task_id, exc)
            await record_review_artifact(
                work_id=task_id,
                agent_kind=agent_kind,
                scope_id=scope_id,
                model=model.id,
                digest_hash_value=digest_fingerprint,
                output={},
                status="discarded",
                error_message=f"model_call_failed: {exc}",
            )
            return

    try:
        output = filter_review_output(parse_review_output(text))
    except Exception as exc:
        LOGGER.info("复盘输出校验失败，丢弃（task=%s）：%s", task_id, exc)
        await record_review_artifact(
            work_id=task_id,
            agent_kind=agent_kind,
            scope_id=scope_id,
            model=model.id,
            digest_hash_value=digest_fingerprint,
            output={},
            status="discarded",
            error_message=f"validation_failed: {exc}",
        )
        return

    if not review_output_has_content(output):
        await record_review_artifact(
            work_id=task_id,
            agent_kind=agent_kind,
            scope_id=scope_id,
            model=model.id,
            digest_hash_value=digest_fingerprint,
            output={},
            status="discarded",
            error_message="no_usable_content",
        )
        return

    written = await _write_knowledge(
        output=output,
        scope_id=scope_id,
        task_id=task_id,
    )
    await enforce_semantic_capacity(scope_id)
    if default_status:
        status = default_status
    else:
        status = "pending" if output.skill_updates else "approved"
    await record_review_artifact(
        work_id=task_id,
        agent_kind=agent_kind,
        scope_id=scope_id,
        model=model.id,
        digest_hash_value=digest_fingerprint,
        output=output.model_dump(),
        status=status,
    )
    LOGGER.info(
        "复盘完成 task=%s kind=%s facts=%s lessons=%s skills=%s status=%s",
        task_id,
        agent_kind,
        len(output.facts),
        len(output.lessons),
        len(output.skill_updates),
        status,
    )


async def _review_gate(
    *,
    credentials: LlmCredentials,
    task_id: str,
):
    """通用门控：设置开关 → 模型注册 → 对应 provider key。返回 (model, None)。"""

    settings = await read_review_settings()
    if not settings.enabled:
        return None
    model = resolve_review_model(settings.model_id)
    if model is None:
        LOGGER.warning("复盘模型未注册，跳过：%s", settings.model_id)
        return None
    if not credentials.get(model.provider):
        LOGGER.info(
            "未配置 %s API Key，跳过复盘（task=%s）",
            model.provider,
            task_id,
        )
        return None
    return model


async def run_work_review(
    *,
    work_id: str,
    succeeded: bool,
    summary: str,
    error: str,
    failure_kind: str,
    changed_files: list[str],
    transcript_tail: list[str],
    project_id: str,
    credentials: LlmCredentials,
    session_id: str = "",
    audit_dir: str | None = None,
) -> None:
    """Code Agent：单个 Work 完成/失败后的异步复盘。"""

    try:
        model = await _review_gate(credentials=credentials, task_id=work_id)
        if model is None:
            return
        digest = build_work_digest(
            work_id=work_id,
            succeeded=succeeded,
            summary=summary,
            error=error,
            failure_kind=failure_kind,
            changed_files=changed_files,
            transcript_tail=transcript_tail,
            project_id=project_id,
            audit_dir=audit_dir,
        )
        if digest is None:
            LOGGER.info("复盘材料信息量不足，跳过（work=%s）", work_id)
            return
        scope_id = (project_id or "").strip() or "global"
        await _review_common(
            task_id=work_id,
            agent_kind="code",
            scope_id=scope_id,
            digest=digest,
            credentials=credentials,
            model=model,
            system_prompt=_SYSTEM_PROMPT,
            user_template=_USER_TEMPLATE,
            default_status="",
        )
    except Exception:
        LOGGER.exception("复盘异常（work=%s，不影响主流程）", work_id)


async def run_runtime_review(
    *,
    task_id: str,
    agent_id: str,
    status: str,
    request_text: str,
    result_summary: str,
    error_message: str,
    event_count: int,
    project_id: str,
    session_id: str,
    marketplace: str,
    credentials: LlmCredentials,
    audit_dir: str | None = None,
) -> None:
    """跨境电商 Agent：统一 Runtime 任务完成/失败后的异步复盘。

    - scope 隔离：优先项目，其次 marketplace 业务域，其次会话；
    - 审批门：电商知识默认 pending，人工确认后才视为生效。
    """

    try:
        model = await _review_gate(credentials=credentials, task_id=task_id)
        if model is None:
            return
        digest = build_runtime_digest(
            task_id=task_id,
            agent_id=agent_id,
            status=status,
            request_text=request_text,
            result_summary=result_summary,
            error_message=error_message,
            event_count=event_count,
            project_id=project_id,
            session_id=session_id,
            marketplace=marketplace,
            audit_dir=audit_dir,
        )
        if digest is None:
            LOGGER.info("复盘材料信息量不足，跳过（task=%s）", task_id)
            return
        scope_id = (
            (project_id or "").strip()
            or (f"commerce:{marketplace}" if marketplace.strip() else "")
            or (session_id or "").strip()
            or "global"
        )
        await _review_common(
            task_id=task_id,
            agent_kind="commerce",
            scope_id=scope_id,
            digest=digest,
            credentials=credentials,
            model=model,
            system_prompt=_COMMERCE_SYSTEM_PROMPT,
            user_template=_COMMERCE_USER_TEMPLATE,
            default_status="pending",
        )
    except Exception:
        LOGGER.exception("复盘异常（task=%s，不影响主流程）", task_id)


async def _guarded_review(
    *,
    task_id: str,
    payload: dict[str, Any],
    credentials: LlmCredentials,
) -> None:
    """兜底包装：复盘失败绝不影响主流程，结束后释放并发槽。"""

    try:
        await run_work_review(**payload, credentials=credentials)
    except Exception:
        LOGGER.exception("复盘兜底异常（task=%s）", task_id)
    finally:
        _INFLIGHT.discard(task_id)


async def _guarded_runtime_review(
    *,
    task_id: str,
    payload: dict[str, Any],
    credentials: LlmCredentials,
) -> None:
    """电商复盘的兜底包装。"""

    try:
        await run_runtime_review(**payload, credentials=credentials)
    except Exception:
        LOGGER.exception("电商复盘兜底异常（task=%s）", task_id)
    finally:
        _INFLIGHT.discard(task_id)


def schedule_work_review(
    *,
    work_id: str,
    succeeded: bool,
    summary: str,
    error: str,
    failure_kind: str,
    changed_files: list[str],
    transcript_tail: list[str],
    project_id: str,
    credentials: LlmCredentials,
) -> None:
    """Code Agent：Work 完成/失败后调度一次异步复盘（fire-and-forget）。"""

    if not work_id or work_id in _INFLIGHT:
        return
    audit_context = request_audit.get_audit_context()
    _INFLIGHT.add(work_id)
    payload: dict[str, Any] = {
        "work_id": work_id,
        "succeeded": succeeded,
        "summary": summary,
        "error": error,
        "failure_kind": failure_kind,
        "changed_files": list(changed_files or []),
        "transcript_tail": list(transcript_tail or []),
        "project_id": project_id,
        "session_id": audit_context.session_id,
    }
    asyncio.create_task(
        _guarded_review(
            task_id=work_id,
            payload=payload,
            credentials=credentials,
        )
    )


def schedule_runtime_review(
    *,
    task_id: str,
    agent_id: str,
    status: str,
    request_text: str,
    result_summary: str,
    error_message: str,
    event_count: int,
    project_id: str,
    session_id: str,
    marketplace: str,
    credentials: LlmCredentials,
) -> None:
    """电商 Agent：统一 Runtime 任务完成/失败后调度异步复盘。"""

    if not task_id or task_id in _INFLIGHT:
        return
    _INFLIGHT.add(task_id)
    payload: dict[str, Any] = {
        "task_id": task_id,
        "agent_id": agent_id,
        "status": status,
        "request_text": request_text,
        "result_summary": result_summary,
        "error_message": error_message,
        "event_count": event_count,
        "project_id": project_id,
        "session_id": session_id,
        "marketplace": marketplace,
    }
    asyncio.create_task(
        _guarded_runtime_review(
            task_id=task_id,
            payload=payload,
            credentials=credentials,
        )
    )
