-- 角色设定图库：跨会话/跨集复用设定图，同描述同模型只生成一次。
-- (kind, content_hash) 唯一索引做去重键：content_hash = sha256(appearance+outfit+model_id)，
-- 换出图模型视为新图（不同模型出图风格不同，混用伤一致性）。
-- 新建库与存量库升级均幂等（schema_migrations 保证只执行一次）。
CREATE TABLE IF NOT EXISTS media_assets (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    prompt TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_assets_kind_hash
    ON media_assets(kind, content_hash);
