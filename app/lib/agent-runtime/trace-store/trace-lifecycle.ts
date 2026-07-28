/**
 * 模块职责：追踪上下文、事件记录、Span 生命周期和评估保存。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { randomUUID } from "crypto";
import { type AgentTraceEventStatus, type AgentTraceStartInput, DEFAULT_TRACE_MAX_EVENTS_PER_RUN, getDatabase, insertTrace, readPositiveInteger, redactString, sanitizeMetadata, traceStorage, updateTrace } from "./trace-storage";
/** 读取当前异步调用链的 trace id，节点/工具无需逐层传参。 */
export function getCurrentAgentTraceId(): string | null {
  return traceStorage.getStore()?.traceId || null;
}

export function getCurrentAgentTraceContext(): {
  traceId: string;
  sessionId: string;
  projectId: string;
} | null {
  const context = traceStorage.getStore();
  if (!context) return null;
  return {
    traceId: context.traceId,
    sessionId: context.sessionId,
    projectId: context.projectId,
  };
}

/**
 * 写入一条结构化 Trace 事件。
 *
 * metadata 会自动截断并脱敏，避免 API Key、Token 或整份源码被写入监控库。
 */
export function recordAgentTraceEvent(
  category: string,
  name: string,
  status: AgentTraceEventStatus,
  metadata: Record<string, unknown> = {},
  durationMs?: number,
): void {
  const context = traceStorage.getStore();
  if (!context) return;

  const maxEvents = readPositiveInteger(
    "AGENT_TRACE_MAX_EVENTS_PER_RUN",
    DEFAULT_TRACE_MAX_EVENTS_PER_RUN,
  );
  if (context.sequence >= maxEvents) return;

  context.sequence += 1;
  getDatabase()
    .prepare(`
      INSERT INTO agent_trace_events
      (trace_id, sequence, category, name, status, duration_ms, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      context.traceId,
      context.sequence,
      category,
      name,
      status,
      durationMs ?? null,
      JSON.stringify(sanitizeMetadata(metadata)),
      new Date().toISOString(),
    );
}

/** 创建一个可手动结束的 Span，适合 LLM、Tool 和缓存操作。 */
export function startAgentTraceSpan(
  category: string,
  name: string,
  metadata: Record<string, unknown> = {},
): (
  status?: "completed" | "failed",
  endMetadata?: Record<string, unknown>,
) => void {
  const startedAt = performance.now();
  recordAgentTraceEvent(category, name, "started", metadata);
  let ended = false;

  return (status = "completed", endMetadata = {}) => {
    if (ended) return;
    ended = true;
    recordAgentTraceEvent(
      category,
      name,
      status,
      endMetadata,
      Math.round(performance.now() - startedAt),
    );
  };
}

/**
 * 为一次完整 LangGraph 请求建立根 Trace。
 * AsyncLocalStorage 可以覆盖并行 Send Worker，同时保持不同 HTTP 请求隔离。
 */
export async function runWithAgentTrace<T>(
  input: AgentTraceStartInput,
  callback: (traceId: string) => Promise<T>,
): Promise<T> {
  const traceId = insertTrace(input);
  const startedAtMs = Date.now();

  return traceStorage.run(
    {
      traceId,
      sessionId: input.sessionId,
      projectId: input.projectId || "unbound-project",
      sequence: 0,
    },
    async () => {
      recordAgentTraceEvent("graph", "agent_run", "started", {
        model: input.model,
        projectId: input.projectId,
      });
      try {
        const result = await callback(traceId);
        const context = traceStorage.getStore();
        const finalStatus = context?.terminalStatus || "completed";
        recordAgentTraceEvent(
          "graph",
          "agent_run",
          finalStatus === "paused" ? "info" : "completed",
          { finalStatus },
        );
        updateTrace(traceId, finalStatus, startedAtMs);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        recordAgentTraceEvent("graph", "agent_run", "failed", {
          error: message,
        });
        updateTrace(traceId, "failed", startedAtMs, message);
        throw error;
      }
    },
  );
}

/** HITL 暂停时把根 Trace 标记为 paused，而不是误报 completed。 */
export function markCurrentTracePaused(reason: string): void {
  const context = traceStorage.getStore();
  if (!context) return;
  context.terminalStatus = "paused";
  getDatabase()
    .prepare(`
      UPDATE agent_traces
      SET status = 'paused', finished_at = ?, error_message = ?
      WHERE id = ?
    `)
    .run(new Date().toISOString(), redactString(reason), context.traceId);
  recordAgentTraceEvent("hitl", "human_approval", "info", { reason });
}

export function saveAgentEvaluation(
  traceId: string,
  projectId: string,
  engine: string,
  overallScore: number,
  report: Record<string, unknown>,
): string {
  const id = randomUUID();
  getDatabase()
    .prepare(`
      INSERT INTO agent_evaluations
      (id, trace_id, project_id, engine, overall_score, report_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      id,
      traceId,
      projectId || "unbound-project",
      engine,
      overallScore,
      JSON.stringify(sanitizeMetadata(report)),
      new Date().toISOString(),
    );
  return id;
}
