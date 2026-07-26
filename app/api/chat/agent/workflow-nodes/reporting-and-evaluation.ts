/**
 * 模块职责：最终报告生成与 Agent 运行评估。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { DEFAULT_MERGE_RESULT, DEFAULT_REVIEW_PAYLOAD, DEFAULT_VERIFICATION_RESULT, formatHighLevelPlan, formatPlannerPayload } from "../types";
import { evaluateAgentRun, formatAgentEvaluation } from "@/app/lib/agent-runtime/evaluation";
import { recordAgentTraceEvent } from "@/app/lib/agent-runtime/trace-store";
import { FinalReportAgentPromptText } from "../../prompt";
import { AgentRuntimeState, buildLifecycleStateUpdate, buildTokenUsage, createLifecycleTracker, getLatestUserRequest } from "./runtime-lifecycle";
import { appendSummary, invokeLlm, truncateText } from "./terminal-and-memory";
import { formatModifyResults } from "./planner-normalization";
/*
 * Final Report 节点负责把前面所有结构化结果收束成最终结论。
 *
 * 你可以把它理解成“交付总结器”：
 * - Planner 说原计划是什么；
 * - Modify 说具体做了什么；
 * - Reviewer 说是否返工过；
 * - Lint / Build / Test 说工程验证结果如何；
 * 最后统一组织成给用户看的 Markdown 报告。
 */
export async function finalReportNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "final_report_agent",
    "final_report_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("EXECUTING", "正在汇总完整 Agent 执行结果。");

  try {
    const response = await invokeLlm(state, [
      {
        role: "system",
        content: FinalReportAgentPromptText,
      },
      {
        role: "user",
        content: [
          `用户请求:\n${getLatestUserRequest(state)}`,
          `High-Level Plan:\n${JSON.stringify(
            state.highLevelPlan || [],
            null,
            2,
          )}`,
          `High-Level Plan 可读版:\n${formatHighLevelPlan(
            state.highLevelPlan || [],
          )}`,
          `Planner 任务数组:\n${JSON.stringify(
            state.plannerOutput || [],
            null,
            2,
          )}`,
          `Planner 可读版:\n${formatPlannerPayload(
            state.plannerOutput || [],
          )}`,
          `Structured Task List:\n${
            state.structuredTaskListSummary || "暂无"
          }`,
          `Modify 结果:\n${formatModifyResults(state.modifyResults || [])}`,
          `Merged Patch:\n${state.mergedPatchSummary || "暂无"}`,
          `Reviewer 结果:\n${JSON.stringify(
            state.reviewPayload || DEFAULT_REVIEW_PAYLOAD,
            null,
            2,
          )}`,
          `Agent Lifecycle:\n${JSON.stringify(
            state.agentLifecycles || {},
            null,
            2,
          )}`,
          `挂起交互请求:\n${
            state.interactiveRequest
              ? JSON.stringify(state.interactiveRequest, null, 2)
              : "当前没有挂起的交互请求"
          }`,
          `结构化工程验证:
${JSON.stringify(
            state.verificationResult || DEFAULT_VERIFICATION_RESULT,
            null,
            2,
          )}`,
          `校验输出:\n${truncateText(state.lintSummary || "暂无", 4000)}`,
        ].join("\n\n"),
      },
    ], "final_report");

    const finalReportSummary =
      response.choices?.[0]?.message?.content?.trim() ||
      "Final Report Agent 未生成额外结论。";
    tracker.transition("COMPLETED", "Final Report 已生成。");

    return {
      finalReportSummary,
      summary: appendSummary(
        state.summary || "",
        getLatestUserRequest(state),
        finalReportSummary,
      ),
      tokenUsage: buildTokenUsage(response.usage),
      ...buildLifecycleStateUpdate(tracker),
    };
  } catch (error) {
    tracker.transition(
      "FAILED",
      `Final Report 生成失败: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      finalReportSummary: tracker.getSnapshot().detail,
      ...buildLifecycleStateUpdate(tracker),
    };
  }
}

/**
 * 对本轮结果执行低成本在线评估，并把结构化报告写入 Trace SQLite。
 *
 * 这里采用 Ragas 同名维度的确定性近似指标，避免在线链路额外调用多个 Judge
 * 模型；同时保留标准 ragasSample，便于后续导出到 Python Ragas 做离线回归。
 */
export async function agentEvaluationNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const response =
    state.finalReportSummary?.trim() || state.directAnswer?.trim() || "";
  const report = evaluateAgentRun({
    projectId: state.projectId || "",
    requiresChanges: state.requiresChanges === true,
    userRequest: getLatestUserRequest(state),
    response,
    retrievedContexts: [
      state.searchContext || "",
      state.memoryContext || "",
      state.fileContext || "",
    ].filter(Boolean),
    modifyResults: state.modifyResults || [],
    mergeResult: state.mergeResult || DEFAULT_MERGE_RESULT,
    reviewPayload: state.reviewPayload || DEFAULT_REVIEW_PAYLOAD,
    reviewDecision: state.reviewDecision || "PASS",
    verificationResult:
      state.verificationResult || DEFAULT_VERIFICATION_RESULT,
  });
  const evaluationSummary = formatAgentEvaluation(report);
  recordAgentTraceEvent("evaluation", "online_agent_evaluation", "info", {
    reportId: report.id,
    engine: report.engine,
    overallScore: report.overallScore,
    diagnosis: report.diagnosis,
  });

  return {
    evaluationReportId: report.id,
    evaluationSummary,
  };
}
