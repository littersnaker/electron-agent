/**
 * 模块职责：项目与会话的增删改查。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { randomUUID } from "crypto";
import path from "path";
import { assertExistingWorkspaceDirectory, normalizeAndValidateWorkspacePath } from "../workspace-path";
import { type ProjectRow, type SessionMode, type SessionRow, type StoredMessage, type WorkspaceListOptions, type WorkspaceProject, type WorkspaceSession, getDatabase, mapProject, mapSession, now } from "./workspace-database";
/**
 * 按已启用插件裁剪工作区数据。
 *
 * messages_json 可能包含长代码对话或完整 Commerce 报告，因此插件关闭时直接在 SQL
 * 层排除对应会话，比客户端拿到全部数据后再隐藏更能减少首屏解析与 IPC/HTTP 负担。
 */
export function listWorkspace(
  options: WorkspaceListOptions = {},
): {
  projects: WorkspaceProject[];
  sessions: WorkspaceSession[];
} {
  const db = getDatabase();
  const includeCode = options.includeCode === true;
  const includeCommerce = options.includeCommerce === true;
  const projects = includeCode
    ? (db
        .prepare("SELECT * FROM projects ORDER BY last_opened_at DESC")
        .all() as unknown as ProjectRow[])
    : [];

  const sessionSql = includeCode && includeCommerce
    ? "SELECT * FROM sessions ORDER BY updated_at DESC"
    : includeCode
      ? "SELECT * FROM sessions WHERE mode IN ('qa', 'code') ORDER BY updated_at DESC"
      : includeCommerce
        ? "SELECT * FROM sessions WHERE mode IN ('qa', 'commerce') ORDER BY updated_at DESC"
        : "SELECT * FROM sessions WHERE mode = 'qa' ORDER BY updated_at DESC";
  const sessions = db.prepare(sessionSql).all() as unknown as SessionRow[];

  return {
    projects: projects.map(mapProject),
    sessions: sessions.map(mapSession),
  };
}

export function createProject(rootPath: string): WorkspaceProject {
  const absolutePath = normalizeAndValidateWorkspacePath(rootPath);
  const db = getDatabase();
  const existing = db
    .prepare("SELECT * FROM projects WHERE root_path = ?")
    .get(absolutePath) as unknown as ProjectRow | undefined;
  if (existing) {
    const openedAt = now();
    db.prepare("UPDATE projects SET last_opened_at = ? WHERE id = ?").run(
      openedAt,
      existing.id,
    );
    return mapProject({ ...existing, last_opened_at: openedAt });
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

/** 根据 ID 返回项目；聊天路由使用数据库记录作为工作目录唯一事实来源。 */
export function getProjectById(projectId: string): WorkspaceProject | null {
  const row = getDatabase()
    .prepare("SELECT * FROM projects WHERE id = ?")
    .get(projectId) as unknown as ProjectRow | undefined;

  return row ? mapProject(row) : null;
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
      .prepare("SELECT * FROM projects WHERE id = ?")
      .get(input.projectId) as unknown as ProjectRow | undefined;
    if (!project) throw new Error("项目不存在");
    assertExistingWorkspaceDirectory(project.root_path);
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
