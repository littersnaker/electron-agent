-- Agent 评测跑分：运行记录 + 逐用例结果。

CREATE TABLE IF NOT EXISTS eval_runs (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    dataset_name TEXT NOT NULL DEFAULT '',
    total_cases INTEGER NOT NULL DEFAULT 0,
    passed INTEGER NOT NULL DEFAULT 0,
    avg_duration_ms INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'running',
    error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    finished_at TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_agent
ON eval_runs(agent_id, created_at);

CREATE TABLE IF NOT EXISTS eval_case_results (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    case_index INTEGER NOT NULL DEFAULT 0,
    input TEXT NOT NULL DEFAULT '',
    expected TEXT NOT NULL DEFAULT '',
    passed INTEGER NOT NULL DEFAULT 0,
    output TEXT NOT NULL DEFAULT '',
    duration_ms INTEGER NOT NULL DEFAULT 0,
    tokens INTEGER NOT NULL DEFAULT 0,
    error_message TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    FOREIGN KEY(run_id) REFERENCES eval_runs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_eval_cases_run
ON eval_case_results(run_id);
