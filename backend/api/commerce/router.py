"""Commerce Agent 的统一 Runtime API 入口。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from backend.api.commerce.status import read_data_source_status, verify_data_source
from backend.runtime.bootstrap import RUNTIME
from backend.runtime.contracts import RuntimeMessage, RuntimeRequest
from backend.schemas.commerce import CommerceRequest
from backend.services.commerce.credentials import read_credentials
from backend.services.commerce.drafts import (
    DraftNotEditableError,
    list_listing_drafts,
    update_listing_draft_content,
    update_listing_draft_status,
)
from backend.services.llm.catalog import AUTO_MODEL_ID
from backend.services.llm.credentials import resolve_credentials
from backend.utils.sse import create_sse_response

router = APIRouter(tags=["commerce-agent"])


def _runtime_request(
    *,
    body: CommerceRequest,
    request: Request | None,
    workflow: str,
) -> RuntimeRequest:
    """把 Commerce 请求转换成统一 RuntimeRequest。"""

    messages = tuple(
        RuntimeMessage(role=message.role, content=message.content)
        for message in body.messages
    )
    preferred_model = (
        request.headers.get("x-llm-model-id", AUTO_MODEL_ID).strip()
        if request is not None
        else AUTO_MODEL_ID
    )
    return RuntimeRequest(
        agent_id="commerce",
        payload=body,
        preferred_model_id=preferred_model,
        credentials=read_credentials(request),
        session_id=body.session_id or "commerce-session",
        project_id=body.project_id,
        user_text=body.query.strip(),
        messages=messages,
        metadata={
            "route": f"/api/commerce/{workflow}",
            "workflow": workflow,
            "marketplace": body.marketplace,
            "llm": {
                "modelId": preferred_model,
                "credentials": resolve_credentials(request)
                if request is not None
                else None,
            },
        },
    )


@router.post("/api/commerce/research")
async def commerce_research(body: CommerceRequest, request: Request):
    """通过统一 Runtime 启动市场研究 SSE 流。"""

    return create_sse_response(
        RUNTIME.execute_stream(_runtime_request(body=body, request=request, workflow="research"))
    )


@router.post("/api/commerce/listing")
async def commerce_listing(body: CommerceRequest, request: Request):
    """通过统一 Runtime 启动安全的 Listing Demo SSE 流。"""

    return create_sse_response(
        RUNTIME.execute_stream(_runtime_request(body=body, request=request, workflow="listing"))
    )


@router.get("/api/commerce/data-source/status")
async def commerce_data_source_status() -> dict[str, object]:
    """返回不含密钥的数据源配置元数据。"""

    return read_data_source_status()


@router.post("/api/commerce/data-source/status")
async def verify_commerce_data_source(request: Request) -> dict[str, object]:
    """执行用户主动触发的数据源轻量检查。"""

    return await verify_data_source(request)


@router.get("/api/commerce/listing/drafts")
async def commerce_listing_drafts(
    status: str | None = None,
    limit: int = 50,
) -> dict[str, object]:
    """列出待人工确认的 Listing 草稿。"""

    return {
        "items": await list_listing_drafts(
            status=status,
            limit=limit,
        )
    }


@router.put("/api/commerce/listing/drafts/{draft_id}")
async def commerce_update_listing_draft(
    draft_id: str,
    body: dict[str, object],
) -> dict[str, object]:
    """更新一条待确认草稿的内容与备注。"""

    draft = body.get("draft")
    if not isinstance(draft, dict):
        raise HTTPException(status_code=422, detail="draft 必须是对象")
    notes = body.get("notes")
    if notes is not None and not isinstance(notes, str):
        raise HTTPException(status_code=422, detail="notes 必须是字符串")
    try:
        updated = await update_listing_draft_content(
            draft_id,
            draft=draft,
            notes=notes or "",
        )
    except DraftNotEditableError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not updated:
        raise HTTPException(status_code=404, detail="Listing 草稿不存在")
    return {"ok": True}


@router.post("/api/commerce/listing/drafts/{draft_id}/confirm")
async def commerce_confirm_listing_draft(draft_id: str) -> dict[str, object]:
    """人工确认一条 Listing 草稿。"""

    try:
        updated = await update_listing_draft_status(draft_id, "confirmed")
    except DraftNotEditableError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not updated:
        raise HTTPException(status_code=404, detail="Listing 草稿不存在")
    return {"ok": True}


@router.post("/api/commerce/listing/drafts/{draft_id}/reject")
async def commerce_reject_listing_draft(draft_id: str) -> dict[str, object]:
    """驳回一条 Listing 草稿。"""

    try:
        updated = await update_listing_draft_status(draft_id, "rejected")
    except DraftNotEditableError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if not updated:
        raise HTTPException(status_code=404, detail="Listing 草稿不存在")
    return {"ok": True}
