"""Jina 多模态向量检索基础设施。

本包提供三个能力：
1. ``jina_client``：封装 Jina Embedding / Rerank API 调用；
2. ``store``：SQLite BLOB 向量存储与 numpy 余弦相似度检索；
3. ``retrieval`` / ``knowledge`` / ``chunking``：混合检索、知识库索引与切块。
"""

from backend.services.embeddings.jina_client import JinaClient, JinaError, JinaUsage
from backend.services.embeddings.store import ChunkRecord, search_vectors, upsert_chunks

__all__ = [
    "ChunkRecord",
    "JinaClient",
    "JinaError",
    "JinaUsage",
    "search_vectors",
    "upsert_chunks",
]
