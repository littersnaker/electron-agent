-- LLM 单步性能指标：TTFT / tok/s / token 用量（对标 Codex 的可量化指标）
CREATE TABLE IF NOT EXISTS agent_step_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    session_id TEXT NOT NULL DEFAULT '',
    work_id TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    ttft_ms INTEGER,
    tok_per_sec REAL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    total_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_step_metrics_session
ON agent_step_metrics(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_step_metrics_work
ON agent_step_metrics(work_id);
