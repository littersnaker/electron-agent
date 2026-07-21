import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "./state";
import {
  routerNode,
  searchAgentNode,
  memoryAgentNode,
  fileAgentNode,
  mergeContextNode,
  planningAgentNode,
  plannerSchemaValidationNode,
  fileUniquenessCheckNode,
  retryPlannerNode,
  rulesRepairNode,
  singleAgentDegradeNode,
  structuredTaskListNode,
  retryDispatchNode,
  modifyAgentANode,
  modifyAgentBNode,
  modifyAgentCNode,
  mergePatchNode,
  reviewerAgentNode,
  lintBuildTestNode,
  finalReportNode,
} from "./workflow-nodes";
import { getLangGraphCheckpointer } from "./checkpointer";

/*
 * 这个文件是整套多 Agent 流程的“总布线图”。
 *
 * 如果你只想先搞懂整体流程，不想一头扎进 1000+ 行节点实现，
 * 最好的阅读顺序就是：
 * 1. 先看这里，理解节点怎么连；
 * 2. 再去 `state.ts` 看每个节点共享哪些状态；
 * 3. 最后去 `workflow-nodes.ts` 看单个节点内部怎么做。
 *
 * 读法建议：
 * - `addNode()` 看有哪些角色；
 * - `addEdge()` 看正常路径怎么流转；
 * - `addConditionalEdges()` 看哪些地方会分叉、为什么会分叉。
 */
// 新版图结构：
// Router
//   -> Search / Memory / File 并发收集上下文
//   -> Merge Context
//   -> Planner 输出原始 JSON
//   -> JSON Schema 校验
//   -> 文件唯一性检查
//   -> 失败时 Retry Planner，超过上限后走规则修复或单 Agent 降级
//   -> Structured Task List
//   -> Modify A/B/C 并发执行
//   -> Merge Patch（这里只汇总三路结果，不自动合并同文件 patch）
//   -> Reviewer 审查
//   -> RETRY 时只重跑 Reviewer 指定的失败槽位
//   -> PASS 时进入 Lint / Build / Test
//   -> Final Report 产出最终结论
const workflow = new StateGraph(AgentState)
  .addNode("router", routerNode)
  .addNode("search_agent", searchAgentNode)
  .addNode("memory_agent", memoryAgentNode)
  .addNode("file_agent", fileAgentNode)
  .addNode("merge_context", mergeContextNode)
  .addNode("planning_agent", planningAgentNode)
  .addNode("planner_schema_validation", plannerSchemaValidationNode)
  .addNode("file_uniqueness_check", fileUniquenessCheckNode)
  .addNode("retry_planner", retryPlannerNode)
  .addNode("rules_repair", rulesRepairNode)
  .addNode("single_agent_degrade", singleAgentDegradeNode)
  .addNode("structured_task_list", structuredTaskListNode)
  .addNode("retry_dispatch", retryDispatchNode)
  .addNode("modify_agent_a", modifyAgentANode)
  .addNode("modify_agent_b", modifyAgentBNode)
  .addNode("modify_agent_c", modifyAgentCNode)
  .addNode("merge_patch", mergePatchNode)
  .addNode("reviewer_agent", reviewerAgentNode)
  .addNode("lint_build_test", lintBuildTestNode)
  .addNode("final_report", finalReportNode)
  .addEdge("final_report", END);

// 从 START 到 Planner 前这一段，是“上下文收集阶段”。
// 目标不是立刻改代码，而是先把搜索结果、历史记忆、文件预览都凑齐。
workflow.addEdge(START, "router");
workflow.addEdge("router", "search_agent");
workflow.addEdge("router", "memory_agent");
workflow.addEdge("router", "file_agent");
workflow.addEdge("search_agent", "merge_context");
workflow.addEdge("memory_agent", "merge_context");
workflow.addEdge("file_agent", "merge_context");
workflow.addEdge("merge_context", "planning_agent");
workflow.addEdge("planning_agent", "planner_schema_validation");

// Planner 的第一层防线：先看它是不是返回了合法 JSON 结构。
// 不合法时，不会直接往下走 Modify，而是先触发重规划或最终降级。
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

// Planner 的第二层防线：即使 JSON 合法，也要检查多个任务是否撞到了同一个文件。
// 因为一旦多个 Modify 并发改同一个文件，后面的合并和审查都会非常痛苦。
workflow.addConditionalEdges(
  "file_uniqueness_check",
  (state) => {
    if (state.plannerValidationStatus === "files_unique") return "structured";
    return state.plannerRetryCount < 2 ? "retry" : "repair";
  },
  {
    structured: "structured_task_list",
    retry: "retry_planner",
    repair: "rules_repair",
  },
);

// 规则修复是“最后一次自动自救”：
// 如果它能整理出一份稳定的唯一文件任务列表，就还能继续并发执行；
// 如果还是不稳定，就只能降级成单 Agent 串行方案。
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

// 这里之后进入真正的“执行阶段”：
// Structured Task List 把计划整理成人类可读文本，
// 然后 Modify A/B/C 分槽位并发干活。
workflow.addEdge("retry_planner", "planning_agent");
workflow.addEdge("single_agent_degrade", "structured_task_list");
workflow.addEdge("structured_task_list", "modify_agent_a");
workflow.addEdge("structured_task_list", "modify_agent_b");
workflow.addEdge("structured_task_list", "modify_agent_c");
workflow.addEdge("modify_agent_a", "merge_patch");
workflow.addEdge("modify_agent_b", "merge_patch");
workflow.addEdge("modify_agent_c", "merge_patch");
workflow.addEdge("merge_patch", "reviewer_agent");

// Reviewer 是执行阶段的守门员：
// - 通过：进入真实校验
// - 打回：只重跑指定槽位，不让全部 Modify 白白重来
workflow.addConditionalEdges(
  "reviewer_agent",
  // Reviewer 只有两种出路：定向返工或进入真实校验。
  (state) => (state.reviewDecision === "RETRY" ? "retry" : "lint"),
  {
    retry: "retry_dispatch",
    lint: "lint_build_test",
  },
);
workflow.addEdge("retry_dispatch", "modify_agent_a");
workflow.addEdge("retry_dispatch", "modify_agent_b");
workflow.addEdge("retry_dispatch", "modify_agent_c");

// 所有修改通过审查后，最后走一轮 Lint / Build / Test，
// 再由 Final Report 生成最终交付给用户看的总结。
workflow.addEdge("lint_build_test", "final_report");

// compile() 会把这张“设计图”真正变成可运行的状态机。
// 这里同时接入 SQLite checkpointer，让线程状态可持久化，而不是只存内存。
export const graph = workflow.compile({
  checkpointer: getLangGraphCheckpointer(),
});
