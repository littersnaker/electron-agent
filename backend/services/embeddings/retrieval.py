"""混合检索与重排。

检索管线：关键词 + 向量召回 → RRF 融合 →（可选）Jina Rerank 精排 → 返回 Top-K。
项目文件检索与知识库检索共用本模块；父子检索在重排之后执行，用父文本
替换命中的子块，避免“片段命中但上下文不足”。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
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


@dataclass(slots=True)
class KnowledgeSearchResult:
    """知识库检索结果与质量指标。

    ``candidate_count`` 是重排前的候选数（即向量召回数量）；
    ``avg_score`` 是最终 Top-K 来源的相关度分数均值，分数越高表示
    本轮检索结果与问题越相关，可作为“检索质量”的参考。
    """

    sources: list[dict[str, object]]
    recall_k: int
    candidate_count: int
    top_k: int
    reranked: bool
    avg_score: float
    hit_rate: float = 0.0
    top_score: float = 0.0

    def with_derived_metrics(self) -> KnowledgeSearchResult:
        """根据来源分数计算命中率与最高分。

        命中率 = 精排结果中“正相关”（分数 >= 0）来源的占比；Jina 重排分数
        为相对标量，大于等于 0 视为存在正相关，仅供用户快速判断本次检索质量。
        """

        scores = [
            float(item["score"])
            for item in self.sources
            if isinstance(item.get("score"), (int, float))
        ]
        positive = sum(1 for score in scores if score >= 0)
        hit_rate = positive / len(scores) if scores else 0.0
        top_score = max(scores) if scores else 0.0
        return KnowledgeSearchResult(
            sources=self.sources,
            recall_k=self.recall_k,
            candidate_count=self.candidate_count,
            top_k=self.top_k,
            reranked=self.reranked,
            avg_score=self.avg_score,
            hit_rate=round(hit_rate, 4),
            top_score=round(top_score, 4),
        )


def _matches_expect(source: dict[str, object], expect: str) -> bool:
    """判断某个来源是否命中期望路径片段（不区分大小写）。"""

    needle = expect.strip().lower()
    if not needle:
        return False
    path = str(source.get("sourcePath") or "").lower()
    if needle in path:
        return True
    filename = path.split("/")[-1]
    return needle in filename


async def evaluate_knowledge_recall(
    cases: list[tuple[str, str]],
    *,
    api_key: str = "",
    recall_k: int | None = None,
    top_k: int | None = None,
) -> dict[str, object]:
    """用“问题 → 期望文档”测试集计算检索召回率/精确率/F1。

    每个用例跑一次知识库检索（向量召回 → 重排 → top-K），判断返回结果中
    是否包含期望文档。指标口径：
    - 召回率@K = 命中的用例数 ÷ 用例总数；
    - 精确率@K = top-K 返回槽位中真正命中的数量 ÷ (K × 用例总数)；
    - F1 = 2 × P × R ÷ (P + R)。
    """

    settings = get_settings()
    used_recall_k = recall_k or settings.jina_recall_k
    used_top_k = top_k or settings.jina_top_k
    total = len(cases)
    hits = 0
    correct_slots = 0
    score_sum = 0.0
    score_count = 0
    per_case: list[dict[str, object]] = []

    for question, expect in cases:
        result = await search_knowledge(
            question,
            api_key=api_key,
            recall_k=used_recall_k,
            top_k=used_top_k,
        )
        sources = result.sources
        matched = [
            {
                "sourcePath": str(item.get("sourcePath") or ""),
                "position": str(item.get("position") or ""),
                "score": item.get("score"),
            }
            for item in sources
            if _matches_expect(item, expect)
        ]
        hit = bool(matched)
        if hit:
            hits += 1
        correct_slots += len(matched)
        scores = [
            float(item["score"]) for item in sources if isinstance(item.get("score"), (int, float))
        ]
        if scores:
            score_sum += sum(scores)
            score_count += len(scores)
        per_case.append(
            {
                "question": question,
                "expect": expect,
                "hit": hit,
                "matchedSources": matched,
                "topSources": [
                    {
                        "sourcePath": str(item.get("sourcePath") or ""),
                        "position": str(item.get("position") or ""),
                        "score": item.get("score"),
                    }
                    for item in sources
                ],
                "avgScore": round(sum(scores) / len(scores), 4) if scores else 0.0,
            }
        )

    recall = hits / total if total else 0.0
    precision = correct_slots / (used_top_k * total) if total else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall > 0 else 0.0
    return {
        "recallK": used_recall_k,
        "topK": used_top_k,
        "totalCases": total,
        "hits": hits,
        "recallRate": round(recall, 4),
        "precisionRate": round(precision, 4),
        "f1": round(f1, 4),
        "avgScore": round(score_sum / score_count, 4) if score_count else 0.0,
        "cases": per_case,
    }


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
) -> KnowledgeSearchResult:
    """知识库检索：向量召回 → 重排 →（可选）父子替换 → Top-K。

    返回 ``KnowledgeSearchResult``，包含来源列表与检索质量指标；
    未开启 Jina 时来源为空列表（QA 降级为无知识库上下文）。
    """

    settings = get_settings()
    recall_k = recall_k or settings.jina_recall_k
    top_k = top_k or settings.jina_top_k
    client = _resolve_client(api_key)
    if client is None:
        return KnowledgeSearchResult([], recall_k, 0, top_k, False, 0.0)

    try:
        vectors, _usage = await client.embed_texts([query], task="retrieval.query")
    except JinaError as exc:
        LOGGER.warning("知识库向量召回失败，本轮跳过：%s", exc)
        return KnowledgeSearchResult([], recall_k, 0, top_k, False, 0.0)
    if not vectors:
        return KnowledgeSearchResult([], recall_k, 0, top_k, False, 0.0)
    hits = await search_vectors(scope="knowledge", query_vector=vectors[0], limit=recall_k)
    if not hits:
        return KnowledgeSearchResult([], recall_k, 0, top_k, False, 0.0)

    candidate_count = len(hits)
    reranked = False
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
        reranked = True
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
    scores = [
        float(item["score"]) for item in ordered if isinstance(item.get("score"), (int, float))
    ]
    avg_score = sum(scores) / len(scores) if scores else 0.0
    return KnowledgeSearchResult(
        sources=ordered,
        recall_k=recall_k,
        candidate_count=candidate_count,
        top_k=top_k,
        reranked=reranked,
        avg_score=round(avg_score, 4),
    ).with_derived_metrics()
