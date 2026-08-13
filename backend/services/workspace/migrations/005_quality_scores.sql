-- 质量分：五维加权（验证/风险/审核/过程/效率），供历史对比与 Work 展示
CREATE TABLE IF NOT EXISTS quality_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    work_id TEXT NOT NULL DEFAULT '',
    session_id TEXT NOT NULL DEFAULT '',
    score REAL NOT NULL DEFAULT 0,
    dimensions_json TEXT NOT NULL DEFAULT '{}',
    active_weights_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quality_scores_work
ON quality_scores(work_id);
CREATE INDEX IF NOT EXISTS idx_quality_scores_session
ON quality_scores(session_id);
