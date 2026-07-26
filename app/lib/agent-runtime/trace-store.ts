/**
 * 模块职责：Lib Agent Runtime Trace Store 对外兼容入口。
 * 说明：内部实现已按企业级单一职责拆分；保留原导入路径，避免影响调用方。
 */
export type { AgentTraceEventRecord } from "./trace-store/trace-storage";
export type { AgentTraceEventStatus } from "./trace-store/trace-storage";
export type { AgentTraceStartInput } from "./trace-store/trace-storage";
export type { AgentTraceStatus } from "./trace-store/trace-storage";
export type { AgentTraceSummary } from "./trace-store/trace-storage";
export type { AgentTraceToolStats } from "./trace-store/trace-storage";
export { getAgentTraceEvents } from "./trace-store/trace-queries";
export { getAgentTraceToolStats } from "./trace-store/trace-queries";
export { getCurrentAgentTraceContext } from "./trace-store/trace-lifecycle";
export { getCurrentAgentTraceId } from "./trace-store/trace-lifecycle";
export { getLatestEvaluation } from "./trace-store/trace-queries";
export { listRecentAgentTraces } from "./trace-store/trace-queries";
export { markCurrentTracePaused } from "./trace-store/trace-lifecycle";
export { recordAgentTraceEvent } from "./trace-store/trace-lifecycle";
export { runWithAgentTrace } from "./trace-store/trace-lifecycle";
export { saveAgentEvaluation } from "./trace-store/trace-lifecycle";
export { startAgentTraceSpan } from "./trace-store/trace-lifecycle";
