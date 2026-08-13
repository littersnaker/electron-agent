-- 自定义模型支持媒体生成：媒体模式（JSON 数组）、媒体协议与输出类型
-- 新列只在此迁移中添加（SCHEMA_SQL 保持基线不变），新建库与存量库升级均幂等。
ALTER TABLE custom_models ADD COLUMN media_modes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE custom_models ADD COLUMN media_protocol TEXT NOT NULL DEFAULT '';
ALTER TABLE custom_models ADD COLUMN media_output_kind TEXT NOT NULL DEFAULT '';
