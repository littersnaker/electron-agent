"""知识库上传、列表、删除与重建接口。"""

from __future__ import annotations

import json

from fastapi import APIRouter, Form, HTTPException, Request, UploadFile
from pydantic import Field

from backend.core.background import spawn
from backend.schemas.common import FlexibleModel
from backend.schemas.knowledge import (
    KnowledgeEvalRequest,
    KnowledgeSearchRequest,
)
from backend.services.embeddings.knowledge import (
    add_knowledge_document,
    delete_knowledge_document,
    get_knowledge_status,
    index_knowledge_base,
    index_knowledge_document,
    list_knowledge_documents,
)
from backend.services.embeddings.knowledge_settings import (
    read_jina_api_key,
    write_jina_api_key,
)
from backend.services.embeddings.retrieval import (
    evaluate_knowledge_recall,
    search_knowledge,
)

router = APIRouter(tags=["knowledge"])


class KnowledgeKeyBody(FlexibleModel):
    """Jina Key 持久化请求体；空串表示清除。"""

    api_key: str = Field(default="", max_length=400, alias="apiKey")


async def _jina_api_key(request: Request) -> str:
    """Jina Key 解析链：请求头 → 持久化存储（watcher/后台索引靠它兜底）。"""

    header_key = request.headers.get("x-jina-api-key", "").strip()
    if header_key:
        return header_key
    return await read_jina_api_key()


@router.post("/api/knowledge/documents")
async def post_knowledge_document(
    request: Request,
    file: UploadFile,
    metadata: str = Form(default="{}"),
) -> dict[str, object]:
    """上传知识库文档（可带 metadata JSON）并立即触发单文档索引。"""

    try:
        metadata_dict: dict[str, object] = {}
        if metadata and metadata.strip():
            parsed = json.loads(metadata)
            if not isinstance(parsed, dict):
                raise ValueError("metadata 必须是 JSON 对象")
            metadata_dict = parsed
        content = await file.read()
        document = await add_knowledge_document(
            filename=file.filename or "",
            content=content,
            metadata=metadata_dict,
        )
    except (ValueError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    async def _index_document() -> None:
        """后台索引：失败只更新文档状态，不抛出（状态由列表接口可见）。"""

        try:
            await index_knowledge_document(
                str(document["id"]), api_key=await _jina_api_key(request)
            )
        except Exception:  # noqa: BLE001 - 索引失败不影响上传成功，watcher 会兜底重试
            import logging

            logging.getLogger(__name__).exception("知识库文档后台索引失败：%s", document["id"])

    # 异步索引：上传立即返回，前端轮询列表看 status (pending → ready/error)。
    spawn(_index_document())
    return {"document": document, "indexQueued": True}


@router.post("/api/knowledge/search")
async def post_knowledge_search(
    body: KnowledgeSearchRequest, request: Request
) -> dict[str, object]:
    """按 query 检索知识库，支持 metadata 等值过滤与候选数调整。"""

    result = await search_knowledge(
        body.query,
        api_key=await _jina_api_key(request),
        recall_k=body.recall_k,
        top_k=body.top_k,
        metadata_filter=body.metadata_filter,
    )
    return {
        "sources": result.sources,
        "recallK": result.recall_k,
        "candidateCount": result.candidate_count,
        "topK": result.top_k,
        "reranked": result.reranked,
        "avgScore": result.avg_score,
        "hitRate": result.hit_rate,
        "topScore": result.top_score,
    }


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

    spawn(index_knowledge_base(await _jina_api_key(request)))
    return {"ok": True, "started": True}


@router.post("/api/knowledge/key")
async def post_knowledge_key(body: KnowledgeKeyBody) -> dict[str, object]:
    """持久化（或清空）Jina API Key，供 watcher 与后台索引兜底使用。"""

    settings = await write_jina_api_key(body.api_key)
    return settings.to_json()


@router.get("/api/knowledge/status")
async def get_knowledge_status_endpoint(request: Request) -> dict[str, object]:
    """返回知识库与 Jina 配置状态（不含密钥）。"""

    return await get_knowledge_status(await _jina_api_key(request))


@router.post("/api/knowledge/evaluate")
async def post_knowledge_evaluate(
    body: KnowledgeEvalRequest, request: Request
) -> dict[str, object]:
    """用标注测试集评估知识库检索的召回率/精确率/F1。"""

    cases = [
        (case.question.strip(), case.expect.strip())
        for case in body.cases
        if case.question.strip() and case.expect.strip()
    ]
    if not cases:
        raise HTTPException(status_code=400, detail="请至少提供一条“问题 | 期望文档”测试用例。")
    return await evaluate_knowledge_recall(
        cases,
        api_key=await _jina_api_key(request),
        recall_k=body.recall_k,
        top_k=body.top_k,
    )
