"""向量存储：SQLite BLOB 持久化 + numpy 余弦相似度检索。

第一版面向本地桌面应用：单项目几万块文本，全量加载后做矩阵点积，
单次查询耗时几十毫秒，无需引入独立向量数据库。后续规模变大时可把
本模块内部实现替换为 sqlite-vec / LanceDB，检索接口保持不变。
"""

from __future__ import annotations

import logging
import hashlib
import re
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import numpy as np

from backend.services.workspace.database import (
    dumps_json,
    loads_json,
    open_database,
    utc_now_iso,
)

LOGGER = logging.getLogger(__name__)


@dataclass(slots=True)
class ChunkRecord:
    """一条待写入向量库的文本块。"""

    chunk_id: str
    chunk_index: int
    chunk_text: str
    embedding: list[float]
    document_id: str = ""
    model: str = ""
    parent_id: str = ""
    parent_text: str = ""
    position: str = ""


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
    full_text: str = "",
    metadata: dict[str, Any] | None = None,
    content_hash: str = "",
) -> int:
    """整体替换某个来源的向量块并返回写入数量（Document/Chunk 归一化）。

    每个来源对应一条 ``rag_documents``（full_text + metadata + content_hash），
    chunks 整体替换其 ``rag_chunks``；未提供 full_text/hash 时按 chunk 文本
    推导，保证旧调用方无需改动即可工作。没有 chunk 时按删除处理。
    """

    if not chunks and not full_text:
        await delete_source_chunks(scope, source_path)
        return 0
    if not full_text:
        full_text = "\n".join(chunk.chunk_text for chunk in chunks)
    if not content_hash:
        content_hash = hashlib.sha256(full_text.encode("utf-8")).hexdigest()
    metadata_json = dumps_json(metadata or {})
    now = utc_now_iso()
    document_id = ""
    async with open_database() as connection:
        await connection.execute(
            """
            INSERT INTO rag_documents(
                id, scope, source_type, source_path, full_text, metadata_json,
                content_hash, indexed_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(scope, source_path) DO UPDATE SET
                source_type = excluded.source_type,
                full_text = excluded.full_text,
                metadata_json = excluded.metadata_json,
                content_hash = excluded.content_hash,
                indexed_at = excluded.indexed_at,
                updated_at = excluded.updated_at
            """,
            (
                f"doc_{uuid4().hex}",
                scope,
                source_type,
                source_path,
                full_text,
                metadata_json,
                content_hash,
                now,
                now,
            ),
        )
        cursor = await connection.execute(
            "SELECT id FROM rag_documents WHERE scope = ? AND source_path = ?",
            (scope, source_path),
        )
        row = await cursor.fetchone()
        if row:
            document_id = str(row["id"])
        if not document_id:
            return 0
        await connection.execute(
            "DELETE FROM rag_chunks WHERE document_id = ?",
            (document_id,),
        )
        if chunks:
            await connection.executemany(
                """
                INSERT INTO rag_chunks(
                    id, document_id, chunk_index, chunk_text, embedding, model,
                    parent_id, parent_text, position, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                [
                    (
                        chunk.chunk_id,
                        document_id,
                        chunk.chunk_index,
                        chunk.chunk_text,
                        _embedding_to_blob(chunk.embedding),
                        chunk.model or model,
                        chunk.parent_id,
                        chunk.parent_text,
                        chunk.position,
                        now,
                    )
                    for chunk in chunks
                ],
            )
    return len(chunks)


async def delete_source_chunks(scope: str, source_path: str) -> int:
    """删除某个来源的向量块（rag 表 + 旧 document_chunks 一并清理）。"""

    async with open_database() as connection:
        await connection.execute(
            "DELETE FROM rag_documents WHERE scope = ? AND source_path = ?",
            (scope, source_path),
        )
        cursor = await connection.execute(
            "DELETE FROM document_chunks WHERE scope = ? AND source_path = ?",
            (scope, source_path),
        )
    return max(0, cursor.rowcount)


async def delete_scope_chunks(scope: str) -> int:
    """删除某个作用域（项目或知识库）的全部向量块。"""

    async with open_database() as connection:
        await connection.execute(
            "DELETE FROM rag_documents WHERE scope = ?",
            (scope,),
        )
        cursor = await connection.execute(
            "DELETE FROM document_chunks WHERE scope = ?",
            (scope,),
        )
    return max(0, cursor.rowcount)


async def count_scope_chunks(scope: str) -> int:
    """统计某个作用域当前的向量块数量（新 rag 表口径）。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            """
            SELECT COUNT(*) AS count FROM rag_chunks c
            JOIN rag_documents d ON c.document_id = d.id
            WHERE d.scope = ?
            """,
            (scope,),
        )
        row = await cursor.fetchone()
    return int(row["count"]) if row else 0


async def get_document_by_source(
    scope: str, source_path: str
) -> dict[str, Any] | None:
    """按作用域+来源路径读取文档记录（增量索引对比用）。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            """
            SELECT id, scope, source_type, source_path, full_text,
                   metadata_json, content_hash, indexed_at, updated_at
            FROM rag_documents WHERE scope = ? AND source_path = ?
            """,
            (scope, source_path),
        )
        row = await cursor.fetchone()
    if not row:
        return None
    return {
        "id": str(row["id"]),
        "scope": str(row["scope"]),
        "sourceType": str(row["source_type"]),
        "sourcePath": str(row["source_path"]),
        "fullText": str(row["full_text"]),
        "metadata": loads_json(str(row["metadata_json"] or "{}"), {}),
        "contentHash": str(row["content_hash"]),
        "indexedAt": str(row["indexed_at"]),
        "updatedAt": str(row["updated_at"]),
    }


async def list_document_sources(scope: str) -> list[str]:
    """返回某个作用域下已索引的全部来源路径（增量删除检测用）。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT source_path FROM rag_documents WHERE scope = ?",
            (scope,),
        )
        rows = await cursor.fetchall()
    return [str(row["source_path"]) for row in rows]


async def search_vectors(
    *,
    scope: str,
    query_vector: list[float],
    limit: int = 10,
    metadata_filter: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """在指定作用域内按余弦相似度召回 Top-K 文本块，支持 metadata 过滤。

    ``metadata_filter`` 为 ``{key: value}`` 等值条件（AND 语义），用
    ``json_extract`` 在 SQL 层过滤；key 只允许字母/数字/下划线/点/横线，
    防止拼接进 JSON 路径造成注入。
    """

    if not query_vector:
        return []
    where = "d.scope = ?"
    params: list[Any] = [scope]
    for key, value in (metadata_filter or {}).items():
        if not re.match(r"^[A-Za-z0-9_.\-]+$", str(key)):
            continue
        where += f" AND json_extract(d.metadata_json, '$.{key}') = ?"
        params.append(value if isinstance(value, str) else dumps_json(value))
    async with open_database() as connection:
        cursor = await connection.execute(
            f"""
            SELECT c.id, c.chunk_index, c.chunk_text, c.embedding,
                   c.parent_id, c.parent_text, c.position,
                   d.source_type, d.source_path, d.metadata_json
            FROM rag_chunks c
            JOIN rag_documents d ON c.document_id = d.id
            WHERE {where}
            """,
            params,
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
        metadata = loads_json(str(row["metadata_json"] or "{}"), {})
        results.append(
            {
                "chunkId": str(row["id"]),
                "chunkIndex": int(row["chunk_index"]),
                "chunkText": str(row["chunk_text"]),
                "sourceType": str(row["source_type"]),
                "sourcePath": str(row["source_path"]),
                "parentId": str(row["parent_id"]),
                "parentText": str(row["parent_text"]),
                "position": str(row["position"] or ""),
                "metadata": metadata,
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
