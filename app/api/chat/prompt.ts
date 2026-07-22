import { renderPrompt } from "@/app/lib/llm/prompts/registry";

/**
 * 兼容旧 Agent 节点的命名导出。实际内容统一来自 Prompt Registry，
 * 因此 Prompt 版本和供应商调用已经与业务节点解耦。
 */
export const systemPromptText = renderPrompt("final_answer");
export const CliPromptText = renderPrompt("cli");
export const HighLevelPlannerPromptText = renderPrompt("high_level_planner");
export const PlannerPromptText = renderPrompt("task_planner");
export const WorkerMemoryPromptText = renderPrompt("worker_memory");
export const ReviewerPromptText = renderPrompt("reviewer");
export const ModifyWorkerPromptText = renderPrompt("modify_worker");
export const FinalReportAgentPromptText = renderPrompt("final_report_agent");
export const ReadOnlyPromptText = renderPrompt("read_only");
export const QaPromptText = renderPrompt("qa");
