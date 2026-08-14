-- Jina 向量检索相关数据表。
-- document_chunks 同时服务项目文件索引与外部知识库，通过 scope 区分；
-- parent_id / parent_text 为父子检索预留：检索命中子块后可用父文本喂给 LLM。

CREATE TABLE IF NOT EXISTS document_chunks (
    chunk_id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    source_type TEXT NOT NULL,
    source_path TEXT NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    chunk_text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    model TEXT NOT NULL DEFAULT '',
    parent_id TEXT NOT NULL DEFAULT '',
    parent_text TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    UNIQUE(scope, source_path, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_document_chunks_scope
ON document_chunks(scope, source_path);

CREATE TABLE IF NOT EXISTS knowledge_documents (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    file_path TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    chunk_count INTEGER NOT NULL DEFAULT 0,
    error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embedding_usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model TEXT NOT NULL,
    operation TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);
