"""知识库上传、列表、删除与重建接口。"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, UploadFile

from backend.core.background import spawn
from backend.services.embeddings.knowledge import (
    add_knowledge_document,
    delete_knowledge_document,
    get_knowledge_status,
    index_knowledge_base,
    index_knowledge_document,
    list_knowledge_documents,
)

router = APIRouter(tags=["knowledge"])


def _jina_api_key(request: Request) -> str:
    """读取请求头传入的 Jina API Key。"""

    return request.headers.get("x-jina-api-key", "").strip()


@router.post("/api/knowledge/documents")
async def post_knowledge_document(request: Request, file: UploadFile) -> dict[str, object]:
    """上传知识库文档并立即触发单文档索引。"""

    try:
        content = await file.read()
        document = await add_knowledge_document(filename=file.filename or "", content=content)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result = await index_knowledge_document(str(document["id"]), api_key=_jina_api_key(request))
    return {"document": document, "index": result}


@router.get("/api/knowledge/documents")
async def get_knowledge_documents() -> dict[str, object]:
    """返回知识库文档列表。"""

    return {"documents": await list_knowledge_documents()}


@router.delete("/api/knowledge/documents/{document_id}")
async def delete_knowledge_document_endpoint(document_id: str) -> dict[str, object]:
    """删除指定知识库文档及其向量块。"""

    removed = await delete_knowledge_document(document_id)
    if not removed:
        raise HTTPException(status_code=404, detail="知识库文档不存在。")
    return {"ok": True}


@router.post("/api/knowledge/reindex")
async def post_knowledge_reindex(request: Request) -> dict[str, object]:
    """后台重建整个知识库索引（外部文档 + 复盘记忆）。"""

    spawn(index_knowledge_base(_jina_api_key(request)))
    return {"ok": True, "started": True}


@router.get("/api/knowledge/status")
async def get_knowledge_status_endpoint(request: Request) -> dict[str, object]:
    """返回知识库与 Jina 配置状态（不含密钥）。"""

    return await get_knowledge_status(_jina_api_key(request))
