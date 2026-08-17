"""知识库索引：外部文档 + 复盘记忆的统一管理。

索引范围（scope="knowledge"）：
- source_type="doc"：上传到 ``knowledge_dir`` 的外部文档（md/txt/pdf/docx）；
- source_type="memory"：Agent 复盘沉淀的 semantic 记忆（facts / lessons）。

未配置 Jina Key 或开关关闭时，索引与检索函数都应优雅降级，不影响主流程。
"""

from __future__ import annotations

import logging
import hashlib
import sqlite3
from pathlib import Path
from uuid import uuid4

from backend.core.config import get_settings
from backend.services.embeddings.chunking import (
    KNOWLEDGE_CHUNK_CHARS,
    KNOWLEDGE_CHUNK_OVERLAP,
    build_chunks,
    extract_document_text,
    extract_pdf_pages,
)
from backend.services.embeddings.jina_client import JinaClient, JinaError
from backend.services.embeddings.pipeline import embed_and_store
from backend.services.embeddings.store import (
    ChunkRecord,
    delete_source_chunks,
    get_document_by_source,
    get_usage_totals,
    list_document_sources,
)
from backend.services.workspace.database import (
    dumps_json,
    loads_json,
    open_database,
    utc_now_iso,
)

LOGGER = logging.getLogger(__name__)


def _safe_filename(filename: str) -> str:
    """清洗上传文件名，防止路径穿越；只保留文件名部分。"""

    raw = (filename or "").strip().replace("\\", "/").split("/")[-1]
    return raw[:255] or f"document_{uuid4().hex[:12]}"


def _is_supported_extension(filename: str) -> bool:
    """判断文件扩展名是否在知识库白名单内。"""

    suffix = Path(filename).suffix.lower()
    return suffix in get_settings().knowledge_doc_extensions


async def add_knowledge_document(
    *, filename: str, content: bytes, metadata: dict[str, object] | None = None
) -> dict[str, object]:
    """保存上传的知识库文档并登记元数据，返回文档记录。"""

    settings = get_settings()
    safe_name = _safe_filename(filename)
    if not _is_supported_extension(safe_name):
        supported = ",".join(settings.knowledge_doc_extensions) or "未知"
        raise ValueError(f"不支持的文件类型，仅支持：{supported}")
    if len(content) > settings.max_upload_megabytes * 1024 * 1024:
        raise ValueError(f"文件超过大小限制（{settings.max_upload_megabytes}MB）。")

    document_id = f"kb_{uuid4().hex}"
    target = settings.knowledge_dir / f"{document_id}_{safe_name}"
    target.write_bytes(content)
    now = utc_now_iso()
    async with open_database() as connection:
        await connection.execute(
            """
            INSERT INTO knowledge_documents(
                id, filename, file_path, size, status, chunk_count,
                error_message, metadata_json, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'pending', 0, '', ?, ?, ?)
            """,
            (
                document_id,
                safe_name,
                str(target),
                len(content),
                dumps_json(metadata or {}),
                now,
                now,
            ),
        )
    return {
        "id": document_id,
        "filename": safe_name,
        "status": "pending",
        "chunkCount": 0,
        "metadata": metadata or {},
    }


async def list_knowledge_documents() -> list[dict[str, object]]:
    """返回知识库文档列表（按创建时间倒序）。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            """
            SELECT id, filename, file_path, size, status, chunk_count,
                   error_message, metadata_json, created_at, updated_at
            FROM knowledge_documents ORDER BY created_at DESC
            """
        )
        rows = await cursor.fetchall()
    return [
        {
            "id": str(row["id"]),
            "filename": str(row["filename"]),
            "size": int(row["size"]),
            "status": str(row["status"]),
            "chunkCount": int(row["chunk_count"]),
            "errorMessage": str(row["error_message"]),
            "metadata": loads_json(str(row["metadata_json"] or "{}"), {}),
            "createdAt": str(row["created_at"]),
            "updatedAt": str(row["updated_at"]),
        }
        for row in rows
    ]


async def delete_knowledge_document(document_id: str) -> bool:
    """删除文档文件、对应向量块与元数据；不存在时返回 False。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT file_path FROM knowledge_documents WHERE id = ?",
            (document_id,),
        )
        row = await cursor.fetchone()
        if not row:
            return False
        file_path = str(row["file_path"])
        await connection.execute("DELETE FROM knowledge_documents WHERE id = ?", (document_id,))
    await delete_source_chunks("knowledge", file_path)
    try:
        Path(file_path).unlink(missing_ok=True)
    except OSError:
        LOGGER.warning("删除知识库文件失败：%s", file_path)
    return True


async def index_knowledge_base(api_key: str = "") -> dict[str, object]:
    """增量重建整个知识库索引（外部文档 + 复盘记忆）。

    文档按内容哈希跳过未变更项；目录里已消失的登记文档同步清理；
    复盘记忆同样按哈希增量。任一步骤失败只影响当前来源。
    """

    settings = get_settings()
    if not settings.jina_embedding_enabled:
        return {"ok": True, "indexed": 0, "skipped": "jina_embedding_disabled"}
    try:
        client = JinaClient(api_key)
    except JinaError as exc:
        return {"ok": False, "error": str(exc), "indexed": 0}

    document_count = 0
    skipped_count = 0
    failed_documents: list[str] = []
    indexed_paths: set[str] = set()
    registered = await _list_registered_document_paths()
    for path in sorted(settings.knowledge_dir.iterdir()):
        if not path.is_file():
            continue
        if path.suffix.lower() not in settings.knowledge_doc_extensions:
            continue
        document_id = registered.get(str(path))
        indexed_paths.add(str(path))
        if not document_id:
            # 目录里存在未登记的文件（手工放置/残留）时不参与索引，避免生成孤儿块。
            LOGGER.warning("跳过未登记的知识库文件：%s", path.name)
            continue
        result = await index_knowledge_document(document_id, api_key=api_key)
        if result.get("ok"):
            if result.get("skipped"):
                skipped_count += 1
            else:
                document_count += 1
        else:
            failed_documents.append(path.name)

    # 清理已从目录删除但仍在登记表中的文档
    for file_path, document_id in registered.items():
        if file_path not in indexed_paths:
            LOGGER.info("清理已删除的知识库文档：%s", file_path)
            await delete_knowledge_document(document_id)

    memory_count = await _index_memory_entries(client)
    return {
        "ok": True,
        "indexed": document_count,
        "skipped": skipped_count,
        "memoryEntries": memory_count,
        "failed": failed_documents,
    }


async def _list_registered_document_paths() -> dict[str, str]:
    """返回 knowledge_documents 的 file_path -> id 映射。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT id, file_path FROM knowledge_documents"
        )
        rows = await cursor.fetchall()
    return {str(row["file_path"]): str(row["id"]) for row in rows}


async def index_knowledge_document(document_id: str, api_key: str = "") -> dict[str, object]:
    """索引单个知识库文档：解析 → 切块 → 向量化 → 更新状态。

    增量语义：按文档全文哈希与已索引记录比对，内容未变时跳过向量化，
    避免轮询 watcher 反复消耗 Jina 额度。
    """

    settings = get_settings()
    if not settings.jina_embedding_enabled:
        return {"ok": False, "error": "Jina 向量检索未开启，请启用 JINA_EMBEDDING_ENABLED。"}
    async with open_database() as connection:
        cursor = await connection.execute(
            "SELECT file_path, metadata_json FROM knowledge_documents WHERE id = ?",
            (document_id,),
        )
        row = await cursor.fetchone()
    if not row:
        return {"ok": False, "error": "知识库文档不存在。"}
    path = Path(str(row["file_path"]))
    metadata = dict(loads_json(str(row["metadata_json"] or "{}"), {}))
    try:
        client = JinaClient(api_key)
        chunks = _build_document_chunks(path)
        full_text = _document_full_text(path)
        if not full_text:
            full_text = "\n".join(chunk.chunk_text for chunk in chunks)
        digest = hashlib.sha256(full_text.encode("utf-8")).hexdigest()
        existing = await get_document_by_source("knowledge", str(path))
        if existing and existing["contentHash"] == digest:
            await _update_document_status(
                document_id,
                status="ready",
                chunk_count=len(chunks),
                error_message="",
            )
            return {
                "ok": True,
                "documentId": document_id,
                "chunkCount": len(chunks),
                "skipped": True,
            }
        metadata.setdefault("filename", path.name)
        metadata.setdefault("sourceType", "doc")
        await embed_and_store(
            client,
            [("knowledge", "doc", str(path), chunk) for chunk in chunks],
            document_info={
                ("knowledge", "doc", str(path)): {
                    "fullText": full_text,
                    "metadata": metadata,
                    "contentHash": digest,
                }
            },
        )
        await _update_document_status(
            document_id,
            status="ready",
            chunk_count=len(chunks),
            error_message="",
        )
        return {"ok": True, "documentId": document_id, "chunkCount": len(chunks)}
    except (JinaError, ValueError, OSError, sqlite3.IntegrityError) as exc:
        await _update_document_status(
            document_id, status="error", chunk_count=0, error_message=str(exc)
        )
        return {"ok": False, "documentId": document_id, "error": str(exc)}


def _document_full_text(path: Path) -> str:
    """提取文档全文（PDF 按页合并，其余按扩展名解析）。"""

    if path.suffix.lower() == ".pdf":
        pages = extract_pdf_pages(path)
        return "\n\n".join(page for page in pages if page.strip())
    return extract_document_text(path)


def _build_document_chunks(path: Path) -> list[ChunkRecord]:
    """把单个知识库文档切成向量块，PDF 按页记录 position。

    PDF 按页切块并记录页码，回答时可以展示“文件名（第 X 页）”；
    md/txt/docx 先抽取全文再统一切块，position 留空。
    """

    if path.suffix.lower() == ".pdf":
        chunks: list[ChunkRecord] = []
        running_index = 0
        for page_index, page_text in enumerate(extract_pdf_pages(path), start=1):
            if not page_text:
                continue
            page_chunks = build_chunks(
                scope="knowledge",
                source_type="doc",
                source_path=str(path),
                text=page_text,
                max_chars=KNOWLEDGE_CHUNK_CHARS,
                overlap=KNOWLEDGE_CHUNK_OVERLAP,
                position=f"第{page_index}页",
                index_offset=running_index,
            )
            running_index += len(page_chunks)
            chunks.extend(page_chunks)
        return chunks

    text = extract_document_text(path)
    return build_chunks(
        scope="knowledge",
        source_type="doc",
        source_path=str(path),
        text=text,
        max_chars=KNOWLEDGE_CHUNK_CHARS,
        overlap=KNOWLEDGE_CHUNK_OVERLAP,
    )


async def _index_memory_entries(client: JinaClient) -> int:
    """把 semantic 复盘记忆切块向量化，纳入知识库检索（按哈希增量）。"""

    async with open_database() as connection:
        cursor = await connection.execute(
            """
            SELECT id, scope_id, content FROM agent_memories
            WHERE memory_type = 'semantic'
              AND (expires_at IS NULL OR expires_at > ?)
            ORDER BY updated_at DESC
            """,
            (utc_now_iso(),),
        )
        rows = await cursor.fetchall()
    if not rows:
        return 0

    all_chunks: list[tuple[str, str, str, ChunkRecord]] = []
    document_info: dict[tuple[str, str, str], dict[str, object]] = {}
    current_sources: set[str] = set()
    for row in rows:
        memory_id = str(row["id"])
        scope_id = str(row["scope_id"])
        source_path = f"memory:{scope_id}:{memory_id}"
        content = str(row["content"])
        current_sources.add(source_path)
        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        existing = await get_document_by_source("knowledge", source_path)
        if existing and existing["contentHash"] == digest:
            continue
        for chunk in build_chunks(
            scope="knowledge",
            source_type="memory",
            source_path=source_path,
            text=content,
            max_chars=KNOWLEDGE_CHUNK_CHARS,
            overlap=KNOWLEDGE_CHUNK_OVERLAP,
        ):
            all_chunks.append(("knowledge", "memory", source_path, chunk))
        document_info[("knowledge", "memory", source_path)] = {
            "fullText": content,
            "metadata": {
                "sourceType": "memory",
                "memoryId": memory_id,
                "scopeId": scope_id,
            },
            "contentHash": digest,
        }
    # 清理已过期/被删除的 memory 向量
    for source in await list_document_sources("knowledge"):
        if source.startswith("memory:") and source not in current_sources:
            await delete_source_chunks("knowledge", source)
    await embed_and_store(client, all_chunks, document_info=document_info)
    return len(document_info)


async def _update_document_status(
    document_id: str,
    *,
    status: str,
    chunk_count: int,
    error_message: str,
) -> None:
    """更新知识库文档的索引状态。"""

    async with open_database() as connection:
        await connection.execute(
            """
            UPDATE knowledge_documents
            SET status = ?, chunk_count = ?, error_message = ?, updated_at = ?
            WHERE id = ?
            """,
            (status, chunk_count, error_message[:1000], utc_now_iso(), document_id),
        )


async def get_knowledge_status(api_key: str = "") -> dict[str, object]:
    """返回知识库与 Jina 配置状态（不含密钥）。"""

    settings = get_settings()
    usage = await get_usage_totals()
    documents = await list_knowledge_documents()
    has_key = bool(api_key.strip() or settings.jina_api_key)
    return {
        "enabled": settings.jina_embedding_enabled,
        "hasApiKey": has_key,
        "embeddingModel": settings.jina_embedding_model,
        "rerankModel": settings.jina_rerank_model,
        "recallK": settings.jina_recall_k,
        "topK": settings.jina_top_k,
        "parentChildEnabled": settings.jina_parent_child_enabled,
        "documentCount": len(documents),
        "usage": usage,
    }
