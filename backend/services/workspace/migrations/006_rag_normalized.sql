-- RAG 归一化：Document / Chunk 标准模型 + metadata + 增量索引支持。
-- rag_documents 存文档级信息（full_text + metadata + content_hash），
-- rag_chunks 挂到 document_id 下；document_chunks 旧表保留（deprecated）。

ALTER TABLE knowledge_documents ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS rag_documents (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_path TEXT NOT NULL,
    full_text TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    content_hash TEXT NOT NULL DEFAULT '',
    indexed_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(scope, source_path)
);

CREATE INDEX IF NOT EXISTS idx_rag_documents_scope
ON rag_documents(scope, source_path);

CREATE TABLE IF NOT EXISTS rag_chunks (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    chunk_text TEXT NOT NULL DEFAULT '',
    embedding BLOB NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    parent_id TEXT NOT NULL DEFAULT '',
    parent_text TEXT NOT NULL DEFAULT '',
    position TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    FOREIGN KEY(document_id) REFERENCES rag_documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rag_chunks_document
ON rag_chunks(document_id);

-- 迁移旧 document_chunks → rag_documents / rag_chunks。
-- document_id 用确定性 hex 派生（scope|source_path），与分块插入保持一致；
-- full_text/hash 留空，首次增量扫描时按内容重索引并补齐。
INSERT OR IGNORE INTO rag_documents (
    id, scope, source_type, source_path, full_text, metadata_json,
    content_hash, indexed_at, updated_at
)
SELECT 'doc_' || lower(hex(scope || char(124) || source_path)),
       scope, source_type, source_path, '', '{}', '', '', updated_at
FROM document_chunks
GROUP BY scope, source_type, source_path;

INSERT OR IGNORE INTO rag_chunks (
    id, document_id, chunk_index, chunk_text, embedding, model,
    parent_id, parent_text, position, updated_at
)
SELECT chunk_id, 'doc_' || lower(hex(scope || char(124) || source_path)),
       chunk_index, chunk_text, embedding, model, parent_id, parent_text,
       position, updated_at
FROM document_chunks;
