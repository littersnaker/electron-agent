import { END, Send, START, StateGraph } from "@langchain/langgraph";
import { getLangGraphCheckpointer } from "./checkpointer";
import {
  contextFanoutNode,
  enrichContextNode,
  readOnlyAnswerNode,
  requestRouterNode,
  workspaceInfoAnswerNode,
} from "./request-routing-nodes";
import { AgentState } from "./state";
import type {
  ModifyWorkerInput,
  PlanTask,
  SharedWorkerMemory,
} from "./types";
import { createDefaultWorkerMemory } from "./types";
import {
  fileAgentNode,
  fileUniquenessCheckNode,
  finalReportNode,
  highLevelPlanningAgentNode,
  lintBuildTestNode,
  memoryAgentNode,
  mergeContextNode,
  mergePatchNode,
  modifyWorkerNode,
  plannerSchemaValidationNode,
  planningAgentNode,
  retryDispatchNode,
  retryPlannerNode,
  reviewerAgentNode,
  rulesRepairNode,
  searchAgentNode,
  singleAgentDegradeNode,
  structuredTaskListNode,
} from "./workflow-nodes";

type AgentRuntimeState = typeof AgentState.State;

/** 构造所有 Worker 共享但只读的压缩上下文。 */
function buildSharedWorkerMemory(
  state: AgentRuntimeState,
): SharedWorkerMemory {
  return {
    latestUserRequest:
      state.currentUserRequest || "请分析当前项目并完成用户请求。",
    summary: state.summary || "",
    mergedContext: state.mergedContext || "",
    structuredTaskListSummary: state.structuredTaskListSummary || "",
    highLevelPlanSummary: state.highLevelPlanSummary || "",
  };
}

/** 给单个 Dynamic Send Worker 生成隔离输入。 */
function buildWorkerInput(
  state: AgentRuntimeState,
  task: PlanTask,
  slot: number,
): ModifyWorkerInput {
  const retrySuffix =
    (state.reviewIteration || 0) > 0
      ? `_retry_${state.reviewIteration}`
      : "";
  const workerId = `worker_${slot + 1}${retrySuffix}`;
  const previousResult = (state.modifyResults || []).find(
    (item) => item.slot === slot,
  );

  return {
    workerId,
    slot,
    task,
    sharedMemory: buildSharedWorkerMemory(state),
    previousMemory:
      previousResult?.workerMemory || createDefaultWorkerMemory(),
    model: state.model || "auto",
    // /api/chat 已经验证工作目录，图内不再静默退回 process.cwd()。
    workingDir: state.workingDir,
    projectId: state.projectId || "",
    reviewFeedback: state.reviewFeedback || "",
    reviewIteration: state.reviewIteration || 0,
    interactiveRequest:
      state.interactiveRequest?.slot === slot
        ? state.interactiveRequest
        : null,
  };
}

/** 首轮 Dynamic Send fan-out。 */
function dispatchInitialWorkers(state: AgentRuntimeState) {
  if (!state.requiresChanges || !(state.plannerOutput || []).length) {
    return "merge_patch";
  }

  return state.plannerOutput.map(
    (task, slot) =>
      new Send("modify_worker", buildWorkerInput(state, task, slot)),
  );
}

/** Reviewer 返工时只重发指定 slot，并继承该 Worker 的压缩记忆。 */
function dispatchRetryWorkers(state: AgentRuntimeState) {
  const retrySlots = Array.from(new Set(state.retryTaskSlots || []))
    .filter((slot) => Number.isInteger(slot))
    .filter(
      (slot) => slot >= 0 && slot < (state.plannerOutput || []).length,
    );

  if (!retrySlots.length) return "merge_patch";

  return retrySlots.map((slot) =>
    new Send(
      "modify_worker",
      buildWorkerInput(state, state.plannerOutput[slot], slot),
    ),
  );
}

/** Router 后先把纯工作区问题短路，其余请求进入并行上下文收集。 */
function routeAfterRouter(state: AgentRuntimeState): "workspace" | "context" {
  return state.requestMode === "workspace_info" ? "workspace" : "context";
}

/** 上下文合并后，只读请求直接回答，代码修改请求才进入 Planner。 */
function routeAfterContext(state: AgentRuntimeState): "read" | "change" {
  return state.requestMode === "read_only" ? "read" : "change";
}

/*
 * V5 主流程：
 * - workspace_info：本地确定性回答，不调用 Planner；
 * - read_only：Search / Memory / File -> 只读回答；
 * - code_change：继续使用完整 Planner / Worker / Merge / Verify / Review。
 */
const workflow = new StateGraph(AgentState)
  .addNode("router", requestRouterNode)
  .addNode("workspace_info_answer", workspaceInfoAnswerNode)
  .addNode("context_fanout", contextFanoutNode)
  .addNode("search_agent", searchAgentNode)
  .addNode("memory_agent", memoryAgentNode)
  .addNode("file_agent", fileAgentNode)
  .addNode("merge_context", mergeContextNode)
  .addNode("enrich_context", enrichContextNode)
  .addNode("read_only_answer", readOnlyAnswerNode)
  .addNode("high_level_planning_agent", highLevelPlanningAgentNode)
  .addNode("planning_agent", planningAgentNode)
  .addNode("planner_schema_validation", plannerSchemaValidationNode)
  .addNode("file_uniqueness_check", fileUniquenessCheckNode)
  .addNode("retry_planner", retryPlannerNode)
  .addNode("rules_repair", rulesRepairNode)
  .addNode("single_agent_degrade", singleAgentDegradeNode)
  .addNode("structured_task_list", structuredTaskListNode)
  .addNode("retry_dispatch", retryDispatchNode)
  .addNode("modify_worker", modifyWorkerNode)
  .addNode("merge_patch", mergePatchNode)
  .addNode("lint_build_test", lintBuildTestNode)
  .addNode("reviewer_agent", reviewerAgentNode)
  .addNode("final_report", finalReportNode);

workflow.addEdge(START, "router");
workflow.addConditionalEdges("router", routeAfterRouter, {
  workspace: "workspace_info_answer",
  context: "context_fanout",
});
workflow.addEdge("workspace_info_answer", END);

workflow.addEdge("context_fanout", "search_agent");
workflow.addEdge("context_fanout", "memory_agent");
workflow.addEdge("context_fanout", "file_agent");
workflow.addEdge("search_agent", "merge_context");
workflow.addEdge("memory_agent", "merge_context");
workflow.addEdge("file_agent", "merge_context");
workflow.addEdge("merge_context", "enrich_context");
workflow.addConditionalEdges("enrich_context", routeAfterContext, {
  read: "read_only_answer",
  change: "high_level_planning_agent",
});
workflow.addEdge("read_only_answer", END);

workflow.addEdge("high_level_planning_agent", "planning_agent");
workflow.addEdge("planning_agent", "planner_schema_validation");
workflow.addConditionalEdges(
  "planner_schema_validation",
  (state) => {
    if (state.plannerValidationStatus === "schema_valid") return "unique";
    return state.plannerRetryCount < 2 ? "retry" : "degrade";
  },
  {
    unique: "file_uniqueness_check",
    retry: "retry_planner",
    degrade: "single_agent_degrade",
  },
);
workflow.addConditionalEdges(
  "file_uniqueness_check",
  (state) => {
    if (state.plannerValidationStatus === "files_unique") {
      return "structured";
    }
    return state.plannerRetryCount < 2 ? "retry" : "repair";
  },
  {
    structured: "structured_task_list",
    retry: "retry_planner",
    repair: "rules_repair",
  },
);
workflow.addConditionalEdges(
  "rules_repair",
  (state) =>
    state.plannerValidationStatus === "rules_repaired"
      ? "structured"
      : "degrade",
  {
    structured: "structured_task_list",
    degrade: "single_agent_degrade",
  },
);
workflow.addEdge("retry_planner", "planning_agent");
workflow.addEdge("single_agent_degrade", "structured_task_list");
workflow.addConditionalEdges(
  "structured_task_list",
  dispatchInitialWorkers,
  ["modify_worker", "merge_patch"],
);
workflow.addEdge("modify_worker", "merge_patch");
workflow.addEdge("merge_patch", "lint_build_test");
workflow.addEdge("lint_build_test", "reviewer_agent");
workflow.addConditionalEdges(
  "reviewer_agent",
  (state) => {
    if (state.reviewDecision === "RETRY") return "retry";
    if (state.reviewDecision === "FAIL") return "fail";
    return "pass";
  },
  {
    retry: "retry_dispatch",
    fail: "final_report",
    pass: "final_report",
  },
);
workflow.addConditionalEdges(
  "retry_dispatch",
  dispatchRetryWorkers,
  ["modify_worker", "merge_patch"],
);
workflow.addEdge("final_report", END);

export const graph = workflow.compile({
  checkpointer: getLangGraphCheckpointer(),
});
