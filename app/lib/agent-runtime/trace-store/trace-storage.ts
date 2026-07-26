/**
 * 模块职责：Agent 追踪类型、SQLite 存储、脱敏和记录持久化。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
export type AgentTraceStatus = "running" | "completed" | "failed" | "paused";

export type AgentTraceEventStatus = "started" | "completed" | "failed" | "info";

export interface AgentTraceStartInput {
  sessionId: string;
  projectId: string;
  model: string;
  request: string;
}

export interface AgentTraceSummary {
  id: string;
  sessionId: string;
  projectId: string;
  model: string;
  requestPreview: string;
  status: AgentTraceStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  eventCount: number;
}

export interface AgentTraceEventRecord {
  id: number;
  traceId: string;
  sequence: number;
  category: string;
  name: string;
  status: AgentTraceEventStatus;
  durationMs: number | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AgentTraceToolStats {
  total: number;
  succeeded: number;
  failed: number;
  repaired: number;
}

export interface TraceContext {
  traceId: string;
  sessionId: string;
  projectId: string;
  sequence: number;
  /** HITL 暂停等场景覆盖根 Trace 的最终状态。 */
  terminalStatus?: AgentTraceStatus;
}

export interface TraceRow {
  id: string;
  session_id: string;
  project_id: string;
  model: string;
  request_preview: string;
  status: AgentTraceStatus;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  error_message: string | null;
  event_count: number;
}

export interface EventRow {
  id: number;
  trace_id: string;
  sequence: number;
  category: string;
  name: string;
  status: AgentTraceEventStatus;
  duration_ms: number | null;
  metadata_json: string;
  created_at: string;
}

export const traceStorage = new AsyncLocalStorage<TraceContext>();

export const DEFAULT_TRACE_RETENTION_DAYS = 30;

export const DEFAULT_TRACE_MAX_RUNS = 5_000;

export const DEFAULT_TRACE_MAX_EVENTS_PER_RUN = 2_000;

export const TRACE_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;

export let database: DatabaseSync | undefined;

export let lastTracePruneAtMs = 0;

export function readPositiveInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 定期删除过期 Trace，并限制总运行数。
 *
 * 事件和评估表通过外键级联删除，避免可观测数据库长期运行后无限占用磁盘。
 */
export function pruneTraceDatabase(
  targetDatabase: DatabaseSync,
  force = false,
): void {
  const now = Date.now();
  if (!force && now - lastTracePruneAtMs < TRACE_PRUNE_INTERVAL_MS) return;
  lastTracePruneAtMs = now;

  const retentionDays = readPositiveInteger(
    "AGENT_TRACE_RETENTION_DAYS",
    DEFAULT_TRACE_RETENTION_DAYS,
  );
  const maxRuns = readPositiveInteger(
    "AGENT_TRACE_MAX_RUNS",
    DEFAULT_TRACE_MAX_RUNS,
  );
  const cutoff = new Date(
    now - retentionDays * 24 * 60 * 60 * 1_000,
  ).toISOString();

  targetDatabase
    .prepare("DELETE FROM agent_traces WHERE started_at < ?")
    .run(cutoff);
  targetDatabase
    .prepare(`
      DELETE FROM agent_traces
      WHERE id IN (
        SELECT id FROM agent_traces
        ORDER BY started_at DESC
        LIMIT -1 OFFSET ?
      )
    `)
    .run(maxRuns);
}

export function getDatabasePath(): string {
  const dataDirectory =
    process.env.AGENT_DATA_DIR || path.join(process.cwd(), ".agent-data");
  fs.mkdirSync(dataDirectory, { recursive: true });
  return path.join(dataDirectory, "agent-observability.sqlite");
}

export function getDatabase(): DatabaseSync {
  if (database) return database;
  database = new DatabaseSync(getDatabasePath());
  database.exec("PRAGMA journal_mode = WAL;");
  database.exec("PRAGMA foreign_keys = ON;");
  database.exec(`
    CREATE TABLE IF NOT EXISTS agent_traces (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      model TEXT NOT NULL,
      request_preview TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      duration_ms INTEGER,
      error_message TEXT
    );

    CREATE TABLE IF NOT EXISTS agent_trace_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL REFERENCES agent_traces(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      category TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER,
      metadata_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(trace_id, sequence)
    );

    CREATE TABLE IF NOT EXISTS agent_evaluations (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL REFERENCES agent_traces(id) ON DELETE CASCADE,
      project_id TEXT NOT NULL,
      engine TEXT NOT NULL,
      overall_score REAL NOT NULL,
      report_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_agent_traces_started
      ON agent_traces(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_trace_events_trace
      ON agent_trace_events(trace_id, sequence ASC);
    CREATE INDEX IF NOT EXISTS idx_agent_evaluations_trace
      ON agent_evaluations(trace_id, created_at DESC);
  `);
  pruneTraceDatabase(database, true);
  return database;
}

export function redactString(value: string): string {
  return value
    .replace(/(bearer\s+)[a-z0-9._~+/-]+/giu, "$1[REDACTED]")
    .replace(/([?&](?:api[_-]?key|token|secret)=)[^&\s]+/giu, "$1[REDACTED]")
    .slice(0, 4_000);
}

export function sanitizeMetadata(
  value: unknown,
  depth = 0,
): unknown {
  if (depth > 5) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 30).map((item) => sanitizeMetadata(item, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 40)) {
      if (/api.?key|authorization|password|secret|token/iu.test(key)) {
        result[key] = "[REDACTED]";
      } else {
        result[key] = sanitizeMetadata(item, depth + 1);
      }
    }
    return result;
  }
  return String(value);
}

export function parseMetadata(value: string): Record<string, unknown> {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return { raw: value };
  }
}

export function mapTrace(row: TraceRow): AgentTraceSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    projectId: row.project_id,
    model: row.model,
    requestPreview: row.request_preview,
    status: row.status,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    eventCount: row.event_count,
  };
}

export function insertTrace(input: AgentTraceStartInput): string {
  const id = randomUUID();
  const targetDatabase = getDatabase();
  pruneTraceDatabase(targetDatabase);
  targetDatabase
    .prepare(`
      INSERT INTO agent_traces
      (id, session_id, project_id, model, request_preview, status, started_at)
      VALUES (?, ?, ?, ?, ?, 'running', ?)
    `)
    .run(
      id,
      input.sessionId,
      input.projectId || "unbound-project",
      input.model,
      redactString(input.request).slice(0, 1_500),
      new Date().toISOString(),
    );
  return id;
}

export function updateTrace(
  traceId: string,
  status: AgentTraceStatus,
  startedAtMs: number,
  errorMessage?: string,
): void {
  const finishedAt = new Date().toISOString();
  const durationMs = Math.max(0, Date.now() - startedAtMs);
  getDatabase()
    .prepare(`
      UPDATE agent_traces
      SET status = ?, finished_at = ?, duration_ms = ?, error_message = ?
      WHERE id = ?
    `)
    .run(
      status,
      finishedAt,
      durationMs,
      errorMessage ? redactString(errorMessage) : null,
      traceId,
    );
}
