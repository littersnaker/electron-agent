-- 给 listing_drafts 增加 updated_at 列，并把历史行回填为创建时间。
-- 该列由草稿编辑/确认/驳回流程维护，用于展示"上次保存时间"。
ALTER TABLE listing_drafts ADD COLUMN updated_at TEXT;

UPDATE listing_drafts SET updated_at = created_at WHERE updated_at IS NULL;
