/**
 * 模块职责：高层规划、任务规划、校验、修复与重试节点。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { advanceWorkingMemory } from "@/app/lib/agent-runtime/three-layer-memory";
import { DEFAULT_PLANNER_PAYLOAD, type HighLevelPlanPayload, type PlannerValidationStatus, formatHighLevelPlan, formatPlannerPayload } from "../types";
import { HighLevelPlannerPromptText, PlannerPromptText } from "../../prompt";
import { type AgentRuntimeState, buildLifecycleStateUpdate, buildTokenUsage, createLifecycleTracker, getLatestUserRequest } from "./runtime-lifecycle";
import { invokeLlm } from "./terminal-and-memory";
import { collectDuplicatePlannerFiles, parseHighLevelPlanWithSchema, parsePlannerPayloadWithSchema } from "./planner-parsing";
import { buildSingleAgentFallbackPlan, getPlannerRetryStatus, normalizePlannerTasks, resolveRetryTaskSlots } from "./planner-normalization";
/*
 * Hierarchical Planner 第一层：先形成模块级工作流，不直接猜文件级细节。
 */
export async function highLevelPlanningAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "high_level_planner",
    "high_level_planner",
    state.plannerRetryCount || 0,
    config,
  );
  tracker.transition("PLANNING", "正在生成模块级 High-Level Plan。");

  try {
    const response = await invokeLlm(state, [
      { role: "system", content: HighLevelPlannerPromptText },
      {
        role: "user",
        content: state.mergedContext || getLatestUserRequest(state),
      },
    ], "planner");
    const highLevelPlanRawOutput =
      response.choices?.[0]?.message?.content || "";
    const parsed = parseHighLevelPlanWithSchema(highLevelPlanRawOutput);

    if (!parsed.success) {
      // 第一层失败时保守生成一个 fallback 工作项，让第二层仍可尝试规划。
      const fallbackPlan: HighLevelPlanPayload = [
        {
          id: "fallback",
          objective: getLatestUserRequest(state),
          scope: ["用户明确提出的修改范围"],
          rationale: parsed.message,
          dependencies: [],
          priority: "high",
        },
      ];
      tracker.transition(
        "COMPLETED",
        "High-Level Plan 解析失败，已生成保守 fallback 工作项。",
      );
      return {
        highLevelPlanRawOutput,
        highLevelPlan: fallbackPlan,
        highLevelPlanSummary: [
          parsed.message,
          formatHighLevelPlan(fallbackPlan),
        ].join("\n\n"),
        tokenUsage: buildTokenUsage(response.usage),
        ...buildLifecycleStateUpdate(tracker),
      };
    }

    tracker.transition(
      "COMPLETED",
      `High-Level Planner 已生成 ${parsed.plan.length} 个模块级工作项。`,
    );
    return {
      highLevelPlanRawOutput,
      highLevelPlan: parsed.plan,
      highLevelPlanSummary: [parsed.message, formatHighLevelPlan(parsed.plan)].join(
        "\n\n",
      ),
      tokenUsage: buildTokenUsage(response.usage),
      ...buildLifecycleStateUpdate(tracker),
    };
  } catch (error) {
    tracker.transition(
      "FAILED",
      `High-Level Planner 执行失败: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    const fallbackPlan: HighLevelPlanPayload = [
      {
        id: "fallback",
        objective: getLatestUserRequest(state),
        scope: ["用户明确提出的修改范围"],
        rationale: "High-Level Planner 调用失败，使用保守降级计划。",
        dependencies: [],
        priority: "high",
      },
    ];
    return {
      highLevelPlan: fallbackPlan,
      highLevelPlanSummary: formatHighLevelPlan(fallbackPlan),
      ...buildLifecycleStateUpdate(tracker),
    };
  }
}

/*
 * Hierarchical Planner 第二层：把 High-Level Plan 转换为可安全并发的叶子任务。
 */
export async function planningAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "task_planner",
    "task_planner",
    state.plannerRetryCount || 0,
    config,
  );
  tracker.transition("PLANNING", "正在生成文件级并发叶子任务。");

  try {
    const response = await invokeLlm(state, [
      { role: "system", content: PlannerPromptText },
      {
        role: "user",
        content: [
          `用户与项目上下文:\n${
            state.mergedContext || getLatestUserRequest(state)
          }`,
          `High-Level Plan:\n${JSON.stringify(
            state.highLevelPlan || [],
            null,
            2,
          )}`,
          state.plannerRetryReason
            ? `上一次规划失败原因:\n${state.plannerRetryReason}`
            : "",
          state.plannerRawOutput
            ? `上一次 Task Planner 原始输出:\n${state.plannerRawOutput}`
            : "",
          `当前已重试次数: ${state.plannerRetryCount || 0}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ], "planner");

    const plannerRawOutput = response.choices?.[0]?.message?.content || "";
    tracker.transition("COMPLETED", "Task Planner 已生成待校验叶子任务。");
    return {
      plannerRawOutput,
      plannerValidationStatus: "pending" as PlannerValidationStatus,
      plannerValidationMessage: "等待进入 Task Planner JSON Schema 校验。",
      tokenUsage: buildTokenUsage(response.usage),
      ...buildLifecycleStateUpdate(tracker),
    };
  } catch (error) {
    tracker.transition(
      "FAILED",
      `Task Planner 执行失败: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      plannerRawOutput: "",
      plannerValidationStatus: "schema_invalid" as PlannerValidationStatus,
      plannerValidationMessage: tracker.getSnapshot().detail,
      ...buildLifecycleStateUpdate(tracker),
    };
  }
}

// Planner 第一层正式校验节点。
// 它把原始文本解析成结构化任务数组，并明确写回“校验通过 / 失败”的状态。
export async function plannerSchemaValidationNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const validationResult = parsePlannerPayloadWithSchema(
    state.plannerRawOutput || "",
    state.highLevelPlan || [],
  );

  return {
    plannerOutput: validationResult.success ? validationResult.tasks : DEFAULT_PLANNER_PAYLOAD,
    requiresChanges: validationResult.success ? validationResult.tasks.length > 0 : false,
    plannerValidationStatus: validationResult.success
      ? ("schema_valid" as PlannerValidationStatus)
      : ("schema_invalid" as PlannerValidationStatus),
    plannerValidationMessage: validationResult.message,
  };
}

// Planner 第二层校验节点。
// 目标很明确：阻止多个并发 Modify 去碰同一个文件。
export async function fileUniquenessCheckNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const duplicateFiles = collectDuplicatePlannerFiles(state.plannerOutput || []);

  if (!duplicateFiles.length) {
    return {
      plannerValidationStatus: "files_unique" as PlannerValidationStatus,
      plannerValidationMessage: "文件唯一性检查通过，没有检测到跨任务重复文件。",
    };
  }

  return {
    plannerValidationStatus: "files_duplicated" as PlannerValidationStatus,
    plannerValidationMessage: `文件唯一性检查失败，检测到重复文件: ${duplicateFiles.join(", ")}`,
  };
}

// Retry Planner 不重新生成计划，它只是更新“为什么要重试、当前是第几次重试”。
// 真正的新规划还是下一轮回到 planningAgentNode 里做。
export async function retryPlannerNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const retryStatus = getPlannerRetryStatus(state);
  return {
    plannerRetryCount: retryStatus.nextRetryCount,
    plannerRetryReason:
      state.plannerValidationMessage || "Planner 校验失败，需要重新规划。",
  };
}

// 规则修复是 Planner 的最后一次自动补救：
// 不再信任模型自己纠正，而是直接在程序层面帮它去重整理。
export async function rulesRepairNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const repairedPlan = normalizePlannerTasks(state.plannerOutput || []);
  const duplicateFiles = collectDuplicatePlannerFiles(repairedPlan);

  if (repairedPlan.length > 0 && duplicateFiles.length === 0) {
    return {
      plannerOutput: repairedPlan,
      requiresChanges: true,
      plannerValidationStatus: "rules_repaired" as PlannerValidationStatus,
      plannerValidationMessage:
        "Planner 多次重试后仍有重复文件，已通过规则修复生成唯一文件任务列表。",
    };
  }

  return {
    plannerValidationStatus: "schema_invalid" as PlannerValidationStatus,
    plannerValidationMessage:
      "规则修复后仍无法得到稳定的唯一文件任务列表，将进入单 Agent 降级执行。",
  };
}

// 如果 Planner 怎么都稳定不下来，就降级成单 Agent 串行执行。
// 这样虽然并发能力没了，但至少能保证流程继续往前走。
export async function singleAgentDegradeNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const fallbackPlan = buildSingleAgentFallbackPlan(state);
  return {
    plannerOutput: fallbackPlan,
    requiresChanges: true,
    plannerValidationStatus: "single_agent_degraded" as PlannerValidationStatus,
    plannerValidationMessage:
      "Planner 多次失败后已降级为单 Agent 执行，避免并发任务继续冲突。",
  };
}

// Structured Task List 节点的主要作用是“把机器结构重新整理成人类可读摘要”。
// 这份摘要后面会给 Modify、Final Report，也方便前端/日志查看。
export async function structuredTaskListNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const taskIds = (state.plannerOutput || []).map((task) => task.id);
  return {
    workingMemory: advanceWorkingMemory(state.workingMemory, {
      phase: "executing",
      activeTaskIds: taskIds,
      pendingTaskIds: taskIds,
      keyFacts: [
        ...(state.workingMemory?.keyFacts || []),
        state.plannerValidationMessage || "Planner 已生成可执行任务。",
      ],
      iteration: state.reviewIteration || 0,
    }),
    structuredTaskListSummary: [
      `Planner 状态: ${state.plannerValidationStatus || "pending"}`,
      `Planner 说明: ${state.plannerValidationMessage || "暂无"}`,
      `Planner 重试次数: ${state.plannerRetryCount || 0}`,
      "",
      "High-Level Plan:",
      JSON.stringify(state.highLevelPlan || [], null, 2),
      "",
      "Structured Task List:",
      JSON.stringify(state.plannerOutput || [], null, 2),
      "",
      formatPlannerPayload(state.plannerOutput || []),
    ].join("\n"),
  };
}

// Retry Dispatcher 本身不做返工，只负责把 Reviewer 指定的返工槽位写回状态。
// 真正执行或跳过返工，是各个 Modify 节点自己判断的。
export async function retryDispatchNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  // MCP 审批恢复时 Router 已精确写入被暂停的 slot，不能再被 Reviewer 规则覆盖。
  const retryTaskSlots =
    state.resumeFromRiskApproval && state.approvalResumeTarget === "worker"
      ? state.retryTaskSlots || []
      : (state.retryTaskSlots || []).length
        ? state.retryTaskSlots
        : resolveRetryTaskSlots(state);

  return {
    retryTaskSlots,
    resumeFromRiskApproval: false,
    approvalResumeTarget: "",
    interactiveRequest: null,
  };
}
