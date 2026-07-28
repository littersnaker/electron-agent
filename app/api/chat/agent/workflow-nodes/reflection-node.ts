/**
 * Cognitive Reflection 节点。
 *
 * Reviewer 负责“代码审查”，Reflection 负责“复盘与策略选择”：
 * - 综合需求覆盖、工程验证、Merge 状态和 Reviewer 结论；
 * - 决定接受、定向返工或停止；
 * - 提取可供 Memory Consolidation 审核的长期记忆候选。
 */
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ReflectionPromptText } from "../../prompt";
import type { PlanTask } from "../types";
import {
  DEFAULT_REFLECTION_PAYLOAD,
  type ReflectionPayload,
} from "@/app/lib/agent-runtime/reflection-types";
import { advanceWorkingMemory } from "@/app/lib/agent-runtime/three-layer-memory";
import { parseReflectionPayload } from "@/app/lib/agent-runtime/reflection-parser";
import {
  type AgentRuntimeState,
  MAX_REVIEW_RETRIES,
  buildLifecycleStateUpdate,
  buildTokenUsage,
  createLifecycleTracker,
  getLatestUserRequest,
} from "./runtime-lifecycle";
import { invokeLlm, truncateText } from "./terminal-and-memory";
import {
  formatModifyResults,
  resolveRetryTaskSlots,
} from "./planner-normalization";

/** 只允许指向当前 Planner 数组的零基任务槽位。 */
function normalizeRetryTasks(
  value: readonly number[] | undefined,
  taskCount: number,
): number[] {
  return Array.from(
    new Set(
      (value || [])
        .filter((slot) => Number.isInteger(slot))
        .filter((slot) => slot >= 0 && slot < taskCount),
    ),
  );
}

/** 模型不可用时采用确定性策略，保证工作流不会因为 Reflection 本身中断。 */
function buildDeterministicReflection(
  state: AgentRuntimeState,
): ReflectionPayload {
  const taskCount = (state.plannerOutput || []).length;
  if (state.reviewDecision === "FAIL") {
    return {
      ...DEFAULT_REFLECTION_PAYLOAD,
      decision: "STOP",
      qualityScore: 0.25,
      diagnosis: state.reviewFeedback || "Reviewer 已明确判定失败。",
    };
  }

  if (
    state.reviewDecision === "RETRY" ||
    state.verificationResult?.overall === "failed"
  ) {
    const retryTasks = normalizeRetryTasks(
      state.retryTaskSlots?.length
        ? state.retryTaskSlots
        : resolveRetryTaskSlots(state),
      taskCount,
    );
    return {
      ...DEFAULT_REFLECTION_PAYLOAD,
      decision:
        retryTasks.length && (state.reviewIteration || 0) <= MAX_REVIEW_RETRIES
          ? "REVISE"
          : "STOP",
      qualityScore: 0.48,
      scores: {
        requirementCoverage: 0.65,
        correctness: 0.45,
        verification: 0.2,
        safety: 0.7,
        maintainability: 0.6,
      },
      diagnosis:
        state.reviewFeedback || "工程验证或 Reviewer 结论要求继续修正。",
      retryTasks,
    };
  }

  return {
    ...DEFAULT_REFLECTION_PAYLOAD,
    decision: "ACCEPT",
    qualityScore: 0.86,
    scores: {
      requirementCoverage: 0.86,
      correctness: 0.84,
      verification:
        state.verificationResult?.overall === "passed" ? 0.95 : 0.72,
      safety: 0.88,
      maintainability: 0.82,
    },
    diagnosis: "Reviewer 已通过，且没有检测到阻断性的 Merge 或验证问题。",
  };
}

/** 强制执行工作流不变量，防止模型输出绕过 Reviewer 或重试上限。 */
function enforceReflectionPolicy(
  state: AgentRuntimeState,
  payload: ReflectionPayload,
): ReflectionPayload {
  const taskCount = (state.plannerOutput || []).length;
  const retryTasks = normalizeRetryTasks(
    payload.retryTasks.length
      ? payload.retryTasks
      : state.retryTaskSlots,
    taskCount,
  );

  if (state.reviewDecision === "FAIL") {
    return { ...payload, decision: "STOP", retryTasks: [] };
  }

  if (
    state.reviewDecision === "RETRY" ||
    state.verificationResult?.overall === "failed"
  ) {
    if (!retryTasks.length || (state.reviewIteration || 0) > MAX_REVIEW_RETRIES) {
      return { ...payload, decision: "STOP", retryTasks: [] };
    }
    return { ...payload, decision: "REVISE", retryTasks };
  }

  if (payload.decision === "REVISE") {
    if (!retryTasks.length || (state.reviewIteration || 0) >= MAX_REVIEW_RETRIES) {
      return { ...payload, decision: "STOP", retryTasks: [] };
    }
    return { ...payload, retryTasks };
  }

  return { ...payload, retryTasks: [] };
}

export async function reflectionAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    `reflection_agent_${state.reviewIteration || 0}`,
    "reflection_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("REFLECTING", "正在复盘执行质量并选择后续策略。");

  let payload: ReflectionPayload;
  let tokenUsage = { prompt: 0, completion: 0, total: 0 };
  let usedFallback = false;

  try {
    const response = await invokeLlm(
      state,
      [
        { role: "system", content: ReflectionPromptText },
        {
          role: "user",
          content: [
            `用户请求:\n${getLatestUserRequest(state)}`,
            `Planner 任务:\n${JSON.stringify(state.plannerOutput || [], null, 2)}`,
            `Worker 结果:\n${truncateText(formatModifyResults(state.modifyResults || []), 8_000)}`,
            `Merge 结果:\n${JSON.stringify(state.mergeResult, null, 2)}`,
            `工程验证:\n${JSON.stringify(state.verificationResult, null, 2)}`,
            `Reviewer:\n${JSON.stringify(state.reviewPayload, null, 2)}`,
            `当前工作记忆:\n${JSON.stringify(state.workingMemory, null, 2)}`,
            `当前返工轮次: ${state.reviewIteration || 0}/${MAX_REVIEW_RETRIES}`,
          ].join("\n\n"),
        },
      ],
      "reflection",
    );
    tokenUsage = buildTokenUsage(response.usage);
    const parsedPayload = parseReflectionPayload(
      response.choices?.[0]?.message?.content || "",
      (state.plannerOutput || []).length,
    );
    payload = parsedPayload || buildDeterministicReflection(state);
    usedFallback = parsedPayload === null;
  } catch {
    payload = buildDeterministicReflection(state);
    usedFallback = true;
  }

  payload = enforceReflectionPolicy(state, payload);
  const shouldIncrementIteration =
    payload.decision === "REVISE" && state.reviewDecision !== "RETRY";
  const nextIteration =
    (state.reviewIteration || 0) + (shouldIncrementIteration ? 1 : 0);
  const nextPhase =
    payload.decision === "ACCEPT"
      ? "completed"
      : payload.decision === "REVISE"
        ? "executing"
        : "failed";
  const taskIds = (state.plannerOutput || []).map((task: PlanTask) => task.id);
  const retryTaskIds = payload.retryTasks
    .map((slot) => state.plannerOutput?.[slot]?.id)
    .filter((id): id is string => Boolean(id));

  const workingMemory = advanceWorkingMemory(state.workingMemory, {
    goal: getLatestUserRequest(state),
    phase: nextPhase,
    activeTaskIds: retryTaskIds,
    completedTaskIds:
      payload.decision === "ACCEPT" ? taskIds : state.workingMemory?.completedTaskIds,
    pendingTaskIds: retryTaskIds,
    keyFacts: [
      ...(state.workingMemory?.keyFacts || []),
      ...payload.lessons,
      payload.diagnosis,
    ],
    risks: [
      ...(state.workingMemory?.risks || []),
      ...(state.reviewPayload?.risks || []),
    ],
    iteration: nextIteration,
  });

  tracker.transition(
    "COMPLETED",
    `${usedFallback ? "确定性降级" : "模型"} Reflection 完成：${payload.decision}，质量分 ${payload.qualityScore.toFixed(2)}。`,
  );

  const reviewDecision =
    payload.decision === "REVISE"
      ? "RETRY"
      : payload.decision === "STOP"
        ? "FAIL"
        : "PASS";
  const reviewFeedback = [state.reviewFeedback, payload.diagnosis]
    .filter(Boolean)
    .join("\n");

  return {
    reflectionPayload: payload,
    reflectionDecision: payload.decision,
    retryTaskSlots: payload.retryTasks,
    reviewPayload: {
      decision: reviewDecision,
      feedback: reviewFeedback,
      risks: state.reviewPayload?.risks || [],
      retryTasks: payload.retryTasks,
    },
    reviewDecision,
    reviewFeedback,
    reviewIteration: nextIteration,
    workingMemory,
    tokenUsage,
    ...buildLifecycleStateUpdate(tracker),
  };
}
