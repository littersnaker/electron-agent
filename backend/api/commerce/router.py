"""Commerce Agent 的统一 Runtime API 入口。"""

from __future__ import annotations

from fastapi import APIRouter, Request

from backend.api.commerce.status import read_data_source_status, verify_data_source
from backend.runtime.bootstrap import RUNTIME
from backend.runtime.contracts import RuntimeMessage, RuntimeRequest
from backend.schemas.commerce import CommerceRequest
from backend.services.commerce.credentials import read_credentials
from backend.services.llm.catalog import AUTO_MODEL_ID
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
