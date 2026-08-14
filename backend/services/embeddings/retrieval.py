"""混合检索与重排。

检索管线：关键词 + 向量召回 → RRF 融合 →（可选）Jina Rerank 精排 → 返回 Top-K。
项目文件检索与知识库检索共用本模块；父子检索在重排之后执行，用父文本
替换命中的子块，避免“片段命中但上下文不足”。
"""

from __future__ import annotations

import logging
from typing import Any

from backend.core.config import get_settings
from backend.services.embeddings.jina_client import JinaClient, JinaError
from backend.services.embeddings.store import search_vectors
from backend.services.workspace.indexer import search_project_index

LOGGER = logging.getLogger(__name__)

RRF_CONSTANT = 60
RERANK_DOCUMENT_CHARS = 3000
# 父子替换的父文本长度上限：超过上限时保留子块，避免上下文爆炸。
MAX_PARENT_REPLACE_CHARS = 8000


def _rrf_merge(ranked: list[list[str]], constant: int = RRF_CONSTANT) -> dict[str, float]:
    """对多个排序列表做 RRF 融合，返回“键 -> 融合分”。"""

    scores: dict[str, float] = {}
    for items in ranked:
        for rank, key in enumerate(items):
            scores[key] = scores.get(key, 0.0) + 1.0 / (constant + rank + 1)
    return scores


def _resolve_client(api_key: str) -> JinaClient | None:
    """按开关与密钥解析客户端；未开启或未配置密钥时返回 None。"""

    settings = get_settings()
    if not settings.jina_embedding_enabled:
        return None
    try:
        return JinaClient(api_key)
    except JinaError as exc:
        LOGGER.info("Jina 客户端不可用，检索降级：%s", exc)
        return None


async def hybrid_search_project(
    project_id: str,
    query: str,
    *,
    api_key: str = "",
    recall_k: int | None = None,
    top_k: int | None = None,
) -> list[dict[str, object]]:
    """项目文件混合检索：关键词 + 向量 → RRF → 重排 → Top-K。

    未开启 Jina 时降级为纯关键词检索（保持原有行为）；
    重排失败时回退到 RRF 融合后的候选。
    """

    settings = get_settings()
    recall_k = recall_k or settings.jina_recall_k
    top_k = top_k or settings.jina_top_k
    client = _resolve_client(api_key)
    if client is None:
        return await search_project_index(project_id, query, limit=top_k)

    keyword = await search_project_index(project_id, query, limit=recall_k)
    keyword_keys = [str(item.get("path") or "") for item in keyword]

    vector_hits: list[dict[str, Any]] = []
    try:
        vectors, _usage = await client.embed_texts([query], task="retrieval.query")
    except JinaError as exc:
        # 向量服务临时不可用时降级为纯关键词，不让 Agent 请求整体失败。
        LOGGER.warning("向量召回失败，降级为关键词检索：%s", exc)
        return keyword[:top_k]
    if vectors:
        vector_hits = await search_vectors(
            scope=project_id, query_vector=vectors[0], limit=recall_k
        )
    vector_keys = [str(item.get("sourcePath") or "") for item in vector_hits]

    merged = _rrf_merge([keyword_keys, vector_keys])
    ordered_keys = sorted(merged, key=merged.get, reverse=True)[:recall_k]

    by_key: dict[str, dict[str, object]] = {}
    for item in keyword:
        path = str(item.get("path") or "")
        if path:
            by_key[path] = {**item, "source": "keyword"}
    for item in vector_hits:
        path = str(item.get("sourcePath") or "")
        if not path:
            continue
        existing = by_key.get(path)
        if existing:
            existing["vectorScore"] = item.get("score")
        else:
            by_key[path] = {
                "path": path,
                "content": str(item.get("chunkText") or ""),
                "size": len(str(item.get("chunkText") or "")),
                "vectorScore": item.get("score"),
                "source": "vector",
            }
    candidates = [by_key[key] for key in ordered_keys if key in by_key]
    if not candidates:
        return []

    try:
        documents = [
            f"{item.get('path')}\n{str(item.get('content') or '')[:RERANK_DOCUMENT_CHARS]}"
            for item in candidates
        ]
        reranked = await client.rerank(query, documents, top_n=top_k)
        selected: list[dict[str, object]] = []
        for hit in reranked:
            index = int(hit.get("index") or 0)
            if 0 <= index < len(candidates):
                item = dict(candidates[index])
                item["score"] = hit.get("score")
                item["source"] = "rerank"
                selected.append(item)
        return selected
    except JinaError as exc:
        LOGGER.warning("项目重排失败，返回混合候选：%s", exc)
        return candidates[:top_k]


async def search_knowledge(
    query: str,
    *,
    api_key: str = "",
    recall_k: int | None = None,
    top_k: int | None = None,
) -> list[dict[str, object]]:
    """知识库检索：向量召回 → 重排 →（可选）父子替换 → Top-K。

    返回结果包含来源路径与父文本；未开启 Jina 时返回空列表（QA 降级为
    无知识库上下文）。
    """

    settings = get_settings()
    recall_k = recall_k or settings.jina_recall_k
    top_k = top_k or settings.jina_top_k
    client = _resolve_client(api_key)
    if client is None:
        return []

    try:
        vectors, _usage = await client.embed_texts([query], task="retrieval.query")
    except JinaError as exc:
        LOGGER.warning("知识库向量召回失败，本轮跳过：%s", exc)
        return []
    if not vectors:
        return []
    hits = await search_vectors(scope="knowledge", query_vector=vectors[0], limit=recall_k)
    if not hits:
        return []

    try:
        documents = [
            f"{item.get('sourcePath')}\n{str(item.get('chunkText') or '')[:RERANK_DOCUMENT_CHARS]}"
            for item in hits
        ]
        reranked = await client.rerank(query, documents, top_n=top_k)
        ordered: list[dict[str, Any]] = []
        for hit in reranked:
            index = int(hit.get("index") or 0)
            if 0 <= index < len(hits):
                item = dict(hits[index])
                item["score"] = hit.get("score")
                ordered.append(item)
    except JinaError as exc:
        LOGGER.warning("知识库重排失败，返回向量候选：%s", exc)
        ordered = [dict(item) for item in hits[:top_k]]

    for item in ordered:
        parent_text = str(item.get("parentText") or "")
        if (
            settings.jina_parent_child_enabled
            and parent_text
            and len(parent_text) <= MAX_PARENT_REPLACE_CHARS
        ):
            item["chunkText"] = parent_text
            item["parentUsed"] = True
    return ordered
