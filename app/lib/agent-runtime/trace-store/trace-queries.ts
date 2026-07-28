/**
 * 模块职责：追踪记录、事件、工具统计和最新评估查询。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */

import { type AgentTraceEventRecord, type AgentTraceSummary, type AgentTraceToolStats, type EventRow, type TraceRow, getDatabase, mapTrace, parseMetadata } from "./trace-storage";
export function listRecentAgentTraces(limit = 30): AgentTraceSummary[] {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 100);
  const rows = getDatabase()
    .prepare(`
      SELECT
        traces.*,
        COUNT(events.id) AS event_count
      FROM agent_traces AS traces
      LEFT JOIN agent_trace_events AS events ON events.trace_id = traces.id
      GROUP BY traces.id
      ORDER BY traces.started_at DESC
      LIMIT ?
    `)
    .all(safeLimit) as unknown as TraceRow[];
  return rows.map(mapTrace);
}

export function getAgentTraceEvents(
  traceId: string,
): AgentTraceEventRecord[] {
  const rows = getDatabase()
    .prepare(`
      SELECT * FROM agent_trace_events
      WHERE trace_id = ?
      ORDER BY sequence ASC
    `)
    .all(traceId) as unknown as EventRow[];
  return rows.map((row) => ({
    id: row.id,
    traceId: row.trace_id,
    sequence: row.sequence,
    category: row.category,
    name: row.name,
    status: row.status,
    durationMs: row.duration_ms,
    metadata: parseMetadata(row.metadata_json),
    createdAt: row.created_at,
  }));
}

export function getAgentTraceToolStats(traceId: string): AgentTraceToolStats {
  const events = getAgentTraceEvents(traceId).filter(
    (event) => event.category === "tool" && event.status !== "started",
  );
  return {
    total: events.length,
    succeeded: events.filter((event) => event.status === "completed").length,
    failed: events.filter((event) => event.status === "failed").length,
    repaired: events.filter((event) => event.metadata.repaired === true).length,
  };
}

export function getLatestEvaluation(
  traceId: string,
): Record<string, unknown> | null {
  const row = getDatabase()
    .prepare(`
      SELECT report_json FROM agent_evaluations
      WHERE trace_id = ?
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get(traceId) as { report_json?: string } | undefined;
  if (!row?.report_json) return null;
  return parseMetadata(row.report_json);
}
