/**
 * 模块职责：代码审查节点与返工判定。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { DEFAULT_REVIEW_PAYLOAD, DEFAULT_VERIFICATION_RESULT, type PlanTask } from "../types";
import { ReviewerPromptText } from "../../prompt";
import { type AgentRuntimeState, MAX_REVIEW_RETRIES, buildLifecycleStateUpdate, buildTokenUsage, createLifecycleTracker, getLatestUserRequest } from "./runtime-lifecycle";
import { uniqueNumbers } from "./merge-strategies";
import { formatModifyResults, formatRetryTasks, resolveRetryTaskSlots } from "./planner-normalization";
import { buildFilePreview } from "./workspace-file-tools";
import { invokeLlm } from "./terminal-and-memory";
import { safeParseReviewPayload } from "./planner-parsing";
/*
 * Reviewer Agent 是“执行阶段的质量闸门”。
 *
 * 它要回答三个问题：
 * 1. 现在的修改能不能过；
 * 2. 具体哪里不够好；
 * 3. 如果要返工，到底返工哪一个任务槽位。
 *
 * 这样就能做到动态 Worker 的局部返工，而不是让全部任务重新执行。
 */
export async function reviewerAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    `reviewer_agent_${state.reviewIteration || 0}`,
    "reviewer_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("REVIEWING", "正在统一审查并发 Worker 与 Merge 结果。");

  const complete = (update: Record<string, unknown>, detail: string) => {
    tracker.transition("COMPLETED", detail);
    return { ...update, ...buildLifecycleStateUpdate(tracker) };
  };
  const fail = (update: Record<string, unknown>, detail: string) => {
    tracker.transition("FAILED", detail);
    return { ...update, ...buildLifecycleStateUpdate(tracker) };
  };

  if (!state.requiresChanges || !(state.plannerOutput || []).length) {
    return complete(
      {
        reviewPayload: DEFAULT_REVIEW_PAYLOAD,
        reviewFeedback: "",
        reviewDecision: "PASS",
        retryTaskSlots: [],
      },
      "当前请求无需代码修改，Reviewer 直接通过。",
    );
  }

  if (state.interactiveRequest || state.mergeResult?.status === "blocked") {
    tracker.transition("BLOCKED", "存在待处理交互请求，Reviewer 暂停。");
    return {
      reviewPayload: {
        decision: "PASS",
        feedback: "存在待处理的交互式命令请求，本轮暂停统一 Review，等待用户继续。",
        risks: ["至少一个并发 Worker 尚未真正完成，当前结果仅为中间态。"],
        retryTasks: [],
      },
      reviewFeedback: "存在挂起的交互请求，Reviewer 暂不继续返工判断。",
      reviewDecision: "PASS",
      retryTaskSlots: [],
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  if (
    state.mergeResult?.status === "conflict" ||
    state.mergeResult?.status === "failed"
  ) {
    const retryTaskSlots = uniqueNumbers(
      (state.mergeResult.conflicts || []).flatMap((conflict) => conflict.slots),
    );
    const feedback = [
      "Merge 阶段检测到并发冲突或 Worker 失败。",
      ...(state.mergeResult.conflicts || []).map((item) => item.message),
    ].join("\n");

    if (
      (state.reviewIteration || 0) < MAX_REVIEW_RETRIES &&
      retryTaskSlots.length
    ) {
      return complete(
        {
          reviewPayload: {
            decision: "RETRY",
            feedback,
            risks: (state.mergeResult.conflicts || []).map(
              (item) => item.message,
            ),
            retryTasks: retryTaskSlots,
          },
          reviewFeedback: feedback,
          reviewDecision: "RETRY",
          retryTaskSlots,
          reviewIteration: (state.reviewIteration || 0) + 1,
        },
        `Reviewer 要求返工槽位: ${formatRetryTasks(retryTaskSlots)}`,
      );
    }

    return fail(
      {
        reviewPayload: {
          decision: "FAIL",
          feedback: `${feedback}\nMerge 冲突尚未解决，自动流程不会把本轮标记为成功。`,
          risks: (state.mergeResult.conflicts || []).map(
            (item) => item.message,
          ),
          retryTasks: [],
        },
        reviewFeedback: feedback,
        reviewDecision: "FAIL",
        retryTaskSlots: [],
      },
      retryTaskSlots.length
        ? "已达到最大返工轮次，Merge 冲突仍未解决。"
        : "Merge 冲突无法映射到可返工 Worker，需人工处理。",
    );
  }

  try {
    const reviewFiles = Array.from(new Set(state.touchedFiles || []));
    const filePreview = await buildFilePreview(
      reviewFiles.length
        ? reviewFiles
        : (state.plannerOutput || []).flatMap((task: PlanTask) => task.files),
      state.workingDir || process.cwd(),
      80,
    );

    const response = await invokeLlm(state, [
      { role: "system", content: ReviewerPromptText },
      {
        role: "user",
        content: [
          `用户请求:\n${getLatestUserRequest(state)}`,
          `High-Level Plan:\n${JSON.stringify(
            state.highLevelPlan || [],
            null,
            2,
          )}`,
          `Planner 任务数组:\n${JSON.stringify(
            state.plannerOutput || [],
            null,
            2,
          )}`,
          `Modify 结果:\n${formatModifyResults(state.modifyResults || [])}`,
          `Merged Patch:\n${state.mergedPatchSummary || "暂无"}`,
          `工程验证:
${JSON.stringify(
            state.verificationResult || DEFAULT_VERIFICATION_RESULT,
            null,
            2,
          )}`,
          `当前 Review 轮次: ${state.reviewIteration || 0}`,
          `当前文件快照:\n${filePreview || "暂无文件快照"}`,
        ].join("\n\n"),
      },
    ], "reviewer");

    const payload = safeParseReviewPayload(
      response.choices?.[0]?.message?.content || "",
    );
    const tokenUsage = buildTokenUsage(response.usage);

    if (payload.decision === "FAIL") {
      return fail(
        {
          reviewPayload: payload,
          reviewFeedback: payload.feedback,
          reviewDecision: "FAIL",
          retryTaskSlots: [],
          tokenUsage,
        },
        payload.feedback || "Reviewer 判断当前修改不可安全通过。",
      );
    }

    if (payload.decision === "RETRY") {
      const retryTaskSlots = payload.retryTasks.length
        ? uniqueNumbers(payload.retryTasks)
        : state.verificationResult?.overall === "failed"
          ? (state.plannerOutput || []).map((_task: PlanTask, slot: number) => slot)
          : resolveRetryTaskSlots(state);

      if (
        (state.reviewIteration || 0) < MAX_REVIEW_RETRIES &&
        retryTaskSlots.length
      ) {
        return complete(
          {
            reviewPayload: { ...payload, retryTasks: retryTaskSlots },
            reviewFeedback: payload.feedback,
            reviewDecision: "RETRY",
            retryTaskSlots,
            reviewIteration: (state.reviewIteration || 0) + 1,
            tokenUsage,
          },
          `Reviewer 要求定向返工: ${formatRetryTasks(retryTaskSlots)}`,
        );
      }

      return fail(
        {
          reviewPayload: {
            ...payload,
            decision: "FAIL",
            feedback: [
              payload.feedback,
              retryTaskSlots.length
                ? "已达到最大返工轮次。"
                : "Reviewer 未能给出有效返工槽位。",
            ]
              .filter(Boolean)
              .join("\n"),
            retryTasks: [],
          },
          reviewFeedback: payload.feedback,
          reviewDecision: "FAIL",
          retryTaskSlots: [],
          tokenUsage,
        },
        "Reviewer 返工请求无法继续安全执行。",
      );
    }

    return complete(
      {
        reviewPayload: payload,
        reviewFeedback: payload.feedback,
        reviewDecision: "PASS",
        retryTaskSlots: [],
        tokenUsage,
      },
      "Unified Reviewer 已完成审查并通过。",
    );
  } catch (error) {
    const detail = `Reviewer 调用失败: ${
      error instanceof Error ? error.message : String(error)
    }`;
    return fail(
      {
        reviewPayload: {
          decision: "FAIL",
          feedback: detail,
          risks: ["Reviewer 模型调用失败，需要人工复查。"],
          retryTasks: [],
        },
        reviewFeedback: detail,
        reviewDecision: "FAIL",
        retryTaskSlots: [],
      },
      detail,
    );
  }
}
