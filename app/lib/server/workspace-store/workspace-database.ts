/**
 * 模块职责：工作区数据类型、SQLite 初始化和行数据映射。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import type { CommerceResearchReport } from "../../commerce/types";
import type { AmazonListingDemoReport } from "../../commerce/listing/types";
export type SessionMode = "qa" | "code" | "commerce";

export type StoredMessageAttachment = {
  name: string;
  type: string;
  dataUrl?: string;
  url?: string;
  assetKind?: "image" | "video" | "file";
  downloadName?: string;
};

export type StoredMessage = {
  role: "user" | "assistant";
  content: string;
  attachments?: StoredMessageAttachment[];
  commerceReport?: CommerceResearchReport;
  commerceListing?: AmazonListingDemoReport;
};

export type WorkspaceProject = {
  id: string;
  name: string;
  rootPath: string;
  indexStatus: "idle" | "indexing" | "ready" | "error";
  indexedFileCount: number;
  lastOpenedAt: string;
};

export type WorkspaceSession = {
  id: string;
  title: string;
  mode: SessionMode;
  projectId: string | null;
  messages: StoredMessage[];
  updatedAt: string;
};

export type ProjectRow = {
  id: string;
  name: string;
  root_path: string;
  index_status: WorkspaceProject["indexStatus"];
  indexed_file_count: number;
  last_opened_at: string;
};

export type SessionRow = {
  id: string;
  title: string;
  mode: SessionMode;
  project_id: string | null;
  messages_json: string;
  updated_at: string;
};

export let database: DatabaseSync | undefined;

export function now(): string {
  return new Date().toISOString();
}

export function getDatabasePath(): string {
  const dataDir =
    process.env.AGENT_DATA_DIR || path.join(process.cwd(), ".agent-data");
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "agent-workspace.sqlite");
}

/**
 * 旧版 SQLite 的 sessions.mode CHECK 只允许 qa/code。
 * SQLite 无法直接修改 CHECK，因此检测到旧表时用事务无损重建表结构。
 */
export function ensureSessionModeSchema(db: DatabaseSync): void {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
    .get() as { sql?: string } | undefined;
  if (!row?.sql || row.sql.includes("'commerce'")) return;

  db.exec(`
    BEGIN IMMEDIATE;
    ALTER TABLE sessions RENAME TO sessions_legacy_mode_v2;
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('qa', 'code', 'commerce')),
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      messages_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO sessions (id, title, mode, project_id, messages_json, created_at, updated_at)
    SELECT id, title, mode, project_id, messages_json, created_at, updated_at
    FROM sessions_legacy_mode_v2;
    DROP TABLE sessions_legacy_mode_v2;
    COMMIT;
  `);
}

export function getDatabase(): DatabaseSync {
  if (database) return database;
  database = new DatabaseSync(getDatabasePath());
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      root_path TEXT NOT NULL UNIQUE,
      index_status TEXT NOT NULL DEFAULT 'idle',
      indexed_file_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      last_opened_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      mode TEXT NOT NULL CHECK(mode IN ('qa', 'code', 'commerce')),
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      messages_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS project_memory (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      memory_key TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project_id, memory_key)
    );

    -- V12：项目级长期记忆。短期记忆和工作记忆不进入该表。
    CREATE TABLE IF NOT EXISTS agent_long_term_memory (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      content_hash TEXT NOT NULL,
      category TEXT NOT NULL,
      content TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_accessed_at TEXT,
      UNIQUE(project_id, content_hash)
    );

    CREATE TABLE IF NOT EXISTS file_index (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      language TEXT,
      modified_at_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      PRIMARY KEY(project_id, file_path)
    );

    CREATE TABLE IF NOT EXISTS symbol_index (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      symbol_name TEXT NOT NULL,
      symbol_kind TEXT NOT NULL,
      line_number INTEGER NOT NULL,
      PRIMARY KEY(project_id, file_path, symbol_name, line_number)
    );

    -- Node's bundled SQLite is not guaranteed to include FTS5. Keep a
    -- portable content index table; search can later be upgraded to FTS5
    -- without changing the workspace schema above it.
    CREATE TABLE IF NOT EXISTS code_content (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      file_path TEXT NOT NULL,
      content TEXT NOT NULL,
      PRIMARY KEY(project_id, file_path)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_project_updated ON sessions(project_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_symbols_project_name ON symbol_index(project_id, symbol_name);
    CREATE INDEX IF NOT EXISTS idx_code_content_project_path ON code_content(project_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_agent_memory_project_updated
      ON agent_long_term_memory(project_id, updated_at DESC);
  `);
  ensureSessionModeSchema(database);
  // 迁移重建 sessions 表时旧索引会随 legacy 表删除，因此这里再次确保索引存在。
  database.exec(
    "CREATE INDEX IF NOT EXISTS idx_sessions_project_updated ON sessions(project_id, updated_at DESC);",
  );
  return database;
}

export function mapProject(row: ProjectRow): WorkspaceProject {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    indexStatus: row.index_status,
    indexedFileCount: row.indexed_file_count,
    lastOpenedAt: row.last_opened_at,
  };
}

export function mapSession(row: SessionRow): WorkspaceSession {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    projectId: row.project_id,
    messages: JSON.parse(row.messages_json) as StoredMessage[],
    updatedAt: row.updated_at,
  };
}

export interface WorkspaceListOptions {
  includeCode?: boolean;
  includeCommerce?: boolean;
}
