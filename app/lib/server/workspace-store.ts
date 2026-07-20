import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";

export type SessionMode = "qa" | "code";

export type StoredMessage = {
  role: "user" | "assistant";
  content: string;
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

type ProjectRow = {
  id: string;
  name: string;
  root_path: string;
  index_status: WorkspaceProject["indexStatus"];
  indexed_file_count: number;
  last_opened_at: string;
};

type SessionRow = {
  id: string;
  title: string;
  mode: SessionMode;
  project_id: string | null;
  messages_json: string;
  updated_at: string;
};

let database: DatabaseSync | undefined;

function now(): string {
  return new Date().toISOString();
}

function getDatabasePath(): string {
  const dataDir =
    process.env.AGENT_DATA_DIR || path.join(process.cwd(), ".agent-data");
  fs.mkdirSync(dataDir, { recursive: true });
  return path.join(dataDir, "agent-workspace.sqlite");
}

function getDatabase(): DatabaseSync {
  if (database) return database;
  console.log("getDatabasePath()", getDatabasePath());
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
      mode TEXT NOT NULL CHECK(mode IN ('qa', 'code')),
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
  `);
  return database;
}

function mapProject(row: ProjectRow): WorkspaceProject {
  return {
    id: row.id,
    name: row.name,
    rootPath: row.root_path,
    indexStatus: row.index_status,
    indexedFileCount: row.indexed_file_count,
    lastOpenedAt: row.last_opened_at,
  };
}

function mapSession(row: SessionRow): WorkspaceSession {
  return {
    id: row.id,
    title: row.title,
    mode: row.mode,
    projectId: row.project_id,
    messages: JSON.parse(row.messages_json) as StoredMessage[],
    updatedAt: row.updated_at,
  };
}

export function listWorkspace(): {
  projects: WorkspaceProject[];
  sessions: WorkspaceSession[];
} {
  const db = getDatabase();
  const projects = db
    .prepare("SELECT * FROM projects ORDER BY last_opened_at DESC")
    .all() as unknown as ProjectRow[];
  const sessions = db
    .prepare("SELECT * FROM sessions ORDER BY updated_at DESC")
    .all() as unknown as SessionRow[];
  return {
    projects: projects.map(mapProject),
    sessions: sessions.map(mapSession),
  };
}

export function createProject(rootPath: string): WorkspaceProject {
  const absolutePath = path.resolve(rootPath);
  const stat = fs.statSync(absolutePath);
  if (!stat.isDirectory()) throw new Error("选择的路径不是目录");

  const db = getDatabase();
  const existing = db
    .prepare("SELECT * FROM projects WHERE root_path = ?")
    .get(absolutePath) as unknown as ProjectRow | undefined;
  if (existing) {
    db.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?").run(
      now(),
      existing.id,
    );
    return mapProject({ ...existing, last_opened_at: now() });
  }

  const project: WorkspaceProject = {
    id: randomUUID(),
    name: path.basename(absolutePath) || absolutePath,
    rootPath: absolutePath,
    indexStatus: "idle",
    indexedFileCount: 0,
    lastOpenedAt: now(),
  };
  db.prepare(
    `INSERT INTO projects (id, name, root_path, index_status, indexed_file_count, created_at, last_opened_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    project.id,
    project.name,
    project.rootPath,
    project.indexStatus,
    0,
    now(),
    project.lastOpenedAt,
  );
  return project;
}

export function createSession(input: {
  mode: SessionMode;
  projectId?: string | null;
  title?: string;
  messages?: StoredMessage[];
}): WorkspaceSession {
  const db = getDatabase();
  if (input.mode === "code" && !input.projectId) {
    throw new Error("Code 会话必须关联一个项目");
  }
  if (input.projectId) {
    const project = db
      .prepare("SELECT id FROM projects WHERE id = ?")
      .get(input.projectId);
    if (!project) throw new Error("项目不存在");
  }
  const createdAt = now();
  const session: WorkspaceSession = {
    id: randomUUID(),
    title: input.title || "新对话",
    mode: input.mode,
    projectId: input.projectId || null,
    messages: input.messages || [],
    updatedAt: createdAt,
  };
  db.prepare(
    `INSERT INTO sessions (id, title, mode, project_id, messages_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    session.id,
    session.title,
    session.mode,
    session.projectId,
    JSON.stringify(session.messages),
    createdAt,
    createdAt,
  );
  return session;
}

export function updateSession(
  input: Pick<WorkspaceSession, "id" | "title" | "messages">,
): WorkspaceSession {
  const db = getDatabase();
  const current = db
    .prepare("SELECT * FROM sessions WHERE id = ?")
    .get(input.id) as unknown as SessionRow | undefined;
  if (!current) throw new Error("会话不存在");
  const updatedAt = now();
  db.prepare(
    "UPDATE sessions SET title = ?, messages_json = ?, updated_at = ? WHERE id = ?",
  ).run(input.title, JSON.stringify(input.messages), updatedAt, input.id);
  return mapSession({
    ...current,
    title: input.title,
    messages_json: JSON.stringify(input.messages),
    updated_at: updatedAt,
  });
}

export function deleteSession(id: string): void {
  getDatabase().prepare("DELETE FROM sessions WHERE id = ?").run(id);
}

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".pnpm-store",
]);
const INDEXED_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".css",
  ".scss",
  ".html",
  ".md",
  ".yml",
  ".yaml",
  ".sql",
  ".py",
  ".go",
  ".java",
  ".rs",
  ".vue",
]);
const MAX_FILE_SIZE = 512 * 1024;
const MAX_INDEXED_FILES = 6000;

function languageFor(filePath: string): string {
  return path.extname(filePath).slice(1) || "text";
}

function extractSymbols(
  content: string,
): Array<{ name: string; kind: string; line: number }> {
  const results: Array<{ name: string; kind: string; line: number }> = [];
  const pattern =
    /^\s*(?:export\s+)?(?:default\s+)?(function|class|interface|type|enum|const)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of content.matchAll(pattern)) {
    const offset = match.index || 0;
    results.push({
      name: match[2],
      kind: match[1],
      line: content.slice(0, offset).split("\n").length,
    });
  }
  return results;
}

function collectFiles(rootPath: string): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    if (files.length >= MAX_INDEXED_FILES) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (files.length >= MAX_INDEXED_FILES) return;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name))
          walk(path.join(directory, entry.name));
        continue;
      }
      const fullPath = path.join(directory, entry.name);
      if (INDEXED_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
        files.push(fullPath);
    }
  };
  walk(rootPath);
  return files;
}

export async function indexProject(
  projectId: string,
): Promise<{ indexedFileCount: number }> {
  const db = getDatabase();
  const project = db
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as unknown as ProjectRow | undefined;
  if (!project) throw new Error("项目不存在");

  db.prepare("UPDATE projects SET index_status = 'indexing' WHERE id = ?").run(
    projectId,
  );
  try {
    const filePaths = collectFiles(project.root_path);
    const indexed = await Promise.all(
      filePaths.map(async (fullPath) => {
        const stat = await fs.promises.stat(fullPath);
        if (stat.size > MAX_FILE_SIZE) return null;
        const content = await fs.promises.readFile(fullPath, "utf8");
        return {
          relativePath: path
            .relative(project.root_path, fullPath)
            .replaceAll("\\", "/"),
          content,
          hash: createHash("sha256").update(content).digest("hex"),
          modifiedAtMs: Math.floor(stat.mtimeMs),
          size: stat.size,
        };
      }),
    );

    const write = () => {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("DELETE FROM file_index WHERE project_id = ?").run(
          projectId,
        );
        db.prepare("DELETE FROM symbol_index WHERE project_id = ?").run(
          projectId,
        );
        db.prepare("DELETE FROM code_content WHERE project_id = ?").run(
          projectId,
        );
        const insertFile = db.prepare(
          "INSERT INTO file_index (project_id, file_path, content_hash, language, modified_at_ms, size_bytes) VALUES (?, ?, ?, ?, ?, ?)",
        );
        const insertSymbol = db.prepare(
          "INSERT INTO symbol_index (project_id, file_path, symbol_name, symbol_kind, line_number) VALUES (?, ?, ?, ?, ?)",
        );
        const insertContent = db.prepare(
          "INSERT INTO code_content (project_id, file_path, content) VALUES (?, ?, ?)",
        );
        let count = 0;
        for (const item of indexed) {
          if (!item) continue;
          count += 1;
          insertFile.run(
            projectId,
            item.relativePath,
            item.hash,
            languageFor(item.relativePath),
            item.modifiedAtMs,
            item.size,
          );
          insertContent.run(projectId, item.relativePath, item.content);
          for (const symbol of extractSymbols(item.content)) {
            insertSymbol.run(
              projectId,
              item.relativePath,
              symbol.name,
              symbol.kind,
              symbol.line,
            );
          }
        }
        db.prepare(
          "UPDATE projects SET index_status = 'ready', indexed_file_count = ?, last_opened_at = ? WHERE id = ?",
        ).run(count, now(), projectId);
        db.exec("COMMIT");
        return count;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };
    return { indexedFileCount: write() };
  } catch (error) {
    db.prepare("UPDATE projects SET index_status = 'error' WHERE id = ?").run(
      projectId,
    );
    throw error;
  }
}

export function searchProjectIndex(
  projectId: string,
  query: string,
): Array<{ filePath: string; snippet: string }> {
  const terms = query
    .trim()
    .split(/\s+/)
    .map((term) => term.replaceAll('"', ""))
    .filter(Boolean);
  if (terms.length === 0) return [];
  const where = terms.map(() => "content LIKE ?").join(" AND ");
  const rows = getDatabase()
    .prepare(
      `SELECT file_path, content FROM code_content WHERE project_id = ? AND ${where} LIMIT 12`,
    )
    .all(projectId, ...terms.map((term) => `%${term}%`)) as unknown as Array<{
    file_path: string;
    content: string;
  }>;
  return rows.map((row) => {
    const index = row.content.toLowerCase().indexOf(terms[0].toLowerCase());
    const start = Math.max(0, index - 120);
    return {
      filePath: row.file_path,
      snippet: row.content.slice(start, start + 360),
    };
  });
}
