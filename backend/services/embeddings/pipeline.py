"""向量化流水线公共函数。

项目文件索引与知识库索引都需要“批量向量化 → 按来源分组写入 → 记录用量”，
这里抽取为公共函数，避免两处各自实现一套逻辑。
"""

from __future__ import annotations

from backend.services.embeddings.jina_client import JinaClient, JinaError
from backend.services.embeddings.store import (
    ChunkRecord,
    record_usage,
    upsert_chunks,
)


async def embed_and_store(
    client: JinaClient,
    grouped: list[tuple[str, str, str, ChunkRecord]],
) -> None:
    """批量向量化并按来源分组写入向量库。

    ``grouped`` 每项为 ``(scope, source_type, source_path, chunk)``；
    向量数量与块数量不一致时抛出 ``JinaError``，由调用方决定降级策略。
    """

    if not grouped:
        return
    texts = [chunk.chunk_text for _, _, _, chunk in grouped]
    vectors, usage = await client.embed_texts(texts)
    if len(vectors) != len(grouped):
        raise JinaError("Jina 返回的向量数量与输入块数量不一致。")
    for (_, _, _, chunk), vector in zip(grouped, vectors, strict=True):
        chunk.embedding = vector

    by_source: dict[tuple[str, str, str], list[ChunkRecord]] = {}
    for scope, source_type, source_path, chunk in grouped:
        key = (scope, source_type, source_path)
        by_source.setdefault(key, []).append(chunk)
    for (scope, source_type, source_path), chunks in by_source.items():
        await upsert_chunks(
            scope=scope,
            source_type=source_type,
            source_path=source_path,
            chunks=chunks,
            model=client.embedding_model,
        )
    await record_usage(
        model=usage.model,
        operation=usage.operation,
        prompt_tokens=usage.prompt_tokens,
        total_tokens=usage.total_tokens,
        scope="mixed",
    )
