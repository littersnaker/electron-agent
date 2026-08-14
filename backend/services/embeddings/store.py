"""向量存储：SQLite BLOB 持久化 + numpy 余弦相似度检索。

第一版面向本地桌面应用：单项目几万块文本，全量加载后做矩阵点积，
单次查询耗时几十毫秒，无需引入独立向量数据库。后续规模变大时可把
本模块内部实现替换为 sqlite-vec / LanceDB，检索接口保持不变。
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import numpy as np

from backend.services.workspace.database import open_database, utc_now_iso

LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class ChunkRecord:
    """一条待写入向量库的文本块。"""

    chunk_id: str
    chunk_index: int
    chunk_text: str
    embedding: list[float]
    model: str = ""
    parent_id: str = ""
    parent_text: str = ""


def _embedding_to_blob(values: list[float]) -> bytes:
    """把向量序列化为 float32 BLOB，便于 SQLite 存储。"""

    return np.asarray(values, dtype=np.float32).tobytes()


def _blob_to_vector(blob: bytes) -> np.ndarray:
    """把数据库 BLOB 还原成 float32 向量。"""

    return np.frombuffer(bytes(blob), dtype=np.float32)


def _normalize_vector(values: list[float] | np.ndarray) -> np.ndarray:
    """对向量做 L2 归一化；零向量时返回全零数组避免除零。"""

    vector = np.asarray(values, dtype=np.float32).reshape(-1)
    norm = float(np.linalg.norm(vector))
    if norm <= 1e-12:
        return np.zeros_like(vector)
    return vector / norm


async def upsert_chunks(
    *,
    scope: str,
    source_type: str,
    source_path: str,
    chunks: list[ChunkRecord],
    model: str = "",
) -> int:
    """整体替换某个来源的向量块并返回写入数量。

    与 ``index_project`` 的“先清空再写入”语义保持一致，保证删除的文件
    不会残留旧向量。
    """

    if not chunks:
        await delete_source_chunks(scope, source_path)
        return 0
    rows = [
        (
            chunk.chunk_id,
            scope,
            source_type,
            source_path,
            chunk.chunk_index,
            chunk.chunk_text,
            _embedding_to_blob(chunk.embedding),
            chunk.model or model,
            chunk.parent_id,
            chunk.parent_text,
            utc_now_iso(),
        )
        for chunk in chunks
    ]
    async with open_database() as connection:
        await connection.execute(
            "DELETE FROM document_chunks WHERE scope = ? AND source_path = ?",
            (scope, source_path),
        )
        await connection.executemany(
            """
            INSERT INTO document_chunks(
                chunk_id, scope, source_type, source_path, chunk_index,
                chunk_text, embedding, model, parent_id, parent_text, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            rows,
        )
    return len(rows)


async def delete_source_chunks(scope: str, source_path: str) -> int:
    """删除某个来源的全部向量块。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "DELETE FROM document_chunks WHERE scope = ? AND source_path = ?",
            (scope, source_path),
        )
    return max(0, cursor.rowcount)


async def delete_scope_chunks(scope: str) -> int:
    """删除某个作用域（项目或知识库）的全部向量块。"""

    async with open_database() as connection:
        cursor = await connection.execute("DELETE FROM document_chunks WHERE scope = ?", (scope,))
    return max(0, cursor.rowcount)


async def count_scope_chunks(scope: str) -> int:
    """统计某个作用域当前的向量块数量。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT COUNT(*) AS count FROM document_chunks WHERE scope = ?",
            (scope,),
        )
        row = await cursor.fetchone()
    return int(row["count"]) if row else 0


async def search_vectors(
    *,
    scope: str,
    query_vector: list[float],
    limit: int = 10,
) -> list[dict[str, Any]]:
    """在指定作用域内按余弦相似度召回 Top-K 文本块。"""

    if not query_vector:
        return []
    async with open_database() as connection:
        cursor = await connection.execute(
            """
            SELECT chunk_id, chunk_index, chunk_text, source_type, source_path,
                   embedding, parent_id, parent_text
            FROM document_chunks WHERE scope = ?
            """,
            (scope,),
        )
        rows = await cursor.fetchall()
    if not rows:
        return []

    vectors = np.vstack(
        [_normalize_vector(_blob_to_vector(bytes(row["embedding"]))) for row in rows]
    )
    query = _normalize_vector(query_vector)
    scores = vectors @ query
    top = min(max(1, limit), len(rows))
    top_indices = np.argpartition(-scores, top - 1)[:top]
    top_indices = top_indices[np.argsort(-scores[top_indices])]

    results: list[dict[str, Any]] = []
    for index in top_indices:
        row = rows[int(index)]
        results.append(
            {
                "chunkId": str(row["chunk_id"]),
                "chunkIndex": int(row["chunk_index"]),
                "chunkText": str(row["chunk_text"]),
                "sourceType": str(row["source_type"]),
                "sourcePath": str(row["source_path"]),
                "parentId": str(row["parent_id"]),
                "parentText": str(row["parent_text"]),
                "score": float(scores[int(index)]),
            }
        )
    return results


async def record_usage(
    *,
    model: str,
    operation: str,
    prompt_tokens: int,
    total_tokens: int,
    scope: str = "",
) -> None:
    """记录一次 Jina 调用的 Token 用量，供免费额度监控。"""

    async with open_database() as connection:
        await connection.execute(
            """
            INSERT INTO embedding_usage(
                model, operation, prompt_tokens, total_tokens, scope, created_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            (model, operation, prompt_tokens, total_tokens, scope, utc_now_iso()),
        )


async def get_usage_totals() -> dict[str, object]:
    """返回全部 Jina Token 用量汇总，按模型与操作拆分。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            """
            SELECT model, operation,
                   SUM(prompt_tokens) AS prompt_tokens,
                   SUM(total_tokens) AS total_tokens
            FROM embedding_usage GROUP BY model, operation ORDER BY total_tokens DESC
            """
        )
        rows = await cursor.fetchall()
        total_cursor = await connection.execute(
            "SELECT COALESCE(SUM(total_tokens), 0) AS total FROM embedding_usage"
        )
        total_row = await total_cursor.fetchone()
    return {
        "items": [
            {
                "model": str(row["model"]),
                "operation": str(row["operation"]),
                "promptTokens": int(row["prompt_tokens"]),
                "totalTokens": int(row["total_tokens"]),
            }
            for row in rows
        ],
        "totalTokens": int(total_row["total"]) if total_row else 0,
    }
