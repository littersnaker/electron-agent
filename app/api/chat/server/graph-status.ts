import { sendSse } from "./sse";
import type { SseController } from "./sse";
import type { AgentLifecycleEventPayload } from "./types";

const LIFECYCLE_STATUS_TEXT: Record<string, string> = {
  CREATED: "已创建",
  PLANNING: "正在规划",
  EXECUTING: "正在执行",
  WAITING_TOOL: "正在调用工具",
  COMPRESSING: "正在压缩上下文",
  READY_TO_MERGE: "已准备合并",
  MERGING: "正在合并",
  REVIEWING: "正在审查",
  VERIFYING: "正在验证",
  BLOCKED: "等待交互",
  COMPLETED: "已完成",
  FAILED: "执行失败",
};

/** 把内部生命周期事件转换成前端可读状态。 */
export function formatLifecycleStatus(
  event: AgentLifecycleEventPayload,
): string {
  const label = event.agentId || event.role || "Agent";
  const status =
    LIFECYCLE_STATUS_TEXT[event.status || ""] ||
    event.status ||
    "状态更新";
  return `${label} ${status}${event.detail ? `：${event.detail}` : ""}`;
}

/**
 * 将 LangGraph 节点更新映射成任务规划面板可识别的状态文字。
 * 只展示稳定节点，不把内部状态对象直接暴露给前端。
 */
export function emitGraphUpdateStatus(
  updates: Record<string, Record<string, unknown>>,
  elapsedSeconds: string,
  controller: SseController,
  encoder: TextEncoder,
): void {
  const statusMessages: Array<[string, string]> = [
    ["router", "🎯 Router 已完成请求分类"],
    ["workspace_info_answer", "📁 已读取当前工作区信息"],
    ["context_fanout", "🧭 正在并行收集项目上下文"],
    ["search_agent", "🔎 SearchAgent 已完成代码检索"],
    ["memory_agent", "🧠 MemoryAgent 已整理历史记忆"],
    ["file_agent", "📂 FileAgent 已读取项目文件上下文"],
    ["merge_context", "🧩 Search、Memory、File 上下文已合并"],
    ["enrich_context", "📍 当前工作区信息已加入上下文"],
    ["read_only_answer", "💬 只读项目回答已生成"],
    ["high_level_planning_agent", "🧭 High-Level Planner 已完成规划"],
    ["planning_agent", "📝 Task Planner 已生成并行任务"],
    ["structured_task_list", "📋 Structured Task List 已生成"],
    ["merge_patch", "🧷 Merge 已完成冲突检查与统一落盘"],
    ["lint_build_test", "🧪 Lint / Build / Test 已完成"],
    ["reviewer_agent", "🕵️ Reviewer 已完成统一审查"],
    ["final_report", "✅ Final Report 已生成"],
  ];

  for (const [nodeName, message] of statusMessages) {
    if (!(nodeName in updates)) continue;
    sendSse(controller, encoder, {
      type: "STATUS",
      content: `${message} (耗时: ${elapsedSeconds}s)`,
    });
  }

  const workerUpdate = updates.modify_worker;
  if (workerUpdate) {
    const results = workerUpdate.modifyResults as
      | Array<{
          workerId?: string;
          slot?: number;
          status?: string;
          interactiveRequest?: Record<string, unknown> | null;
        }>
      | undefined;
    const result = results?.[0];
    const workerLabel =
      result?.workerId ||
      (typeof result?.slot === "number"
        ? `Worker ${result.slot + 1}`
        : "Modify Worker");
    sendSse(controller, encoder, {
      type: "STATUS",
      content: `⚙️ ${workerLabel} ${
        result?.status === "failed" ? "执行失败" : "执行完成"
      } (耗时: ${elapsedSeconds}s)`,
    });

    if (result?.interactiveRequest) {
      sendSse(controller, encoder, {
        type: "INTERACTIVE_REQUEST",
        payload: result.interactiveRequest,
      });
    }
  }
}
