-- 外部 Skill 启用配置：总开关 + 按 Agent 绑定 + 使用率统计
ALTER TABLE installed_skills ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE installed_skills ADD COLUMN agent_ids TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS skill_usage (
    skill_id TEXT PRIMARY KEY,
    hit_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT
);
