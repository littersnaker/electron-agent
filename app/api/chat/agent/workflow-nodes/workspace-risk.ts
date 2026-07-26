/**
 * 模块职责：工作区风险评估、用户审批与补丁合并。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { createHash } from "crypto";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { InteractiveRequest, ModifyTaskResult, WorkerFileChange } from "../types";
import { invalidateProjectContextCache } from "@/app/lib/agent-runtime/context-cache";
import { recordAgentTraceEvent } from "@/app/lib/agent-runtime/trace-store";
import { AgentRuntimeState, buildLifecycleStateUpdate, createLifecycleTracker } from "./runtime-lifecycle";
import { mergeParallelWorkerResults } from "./merge-strategies";
import { formatModifyResults } from "./planner-normalization";
export const SENSITIVE_WORKSPACE_PATH =
  /(?:^|\/)(?:\.env(?:\.|$)|package\.json$|pnpm-lock\.yaml$|package-lock\.json$|yarn\.lock$|docker-compose\.ya?ml$|Dockerfile$|next\.config\.|electron-builder\.|eslint\.config\.|tsconfig\.json$|(?:auth|security|permissions?)(?:\/|$|\.))/iu;

export const RISK_APPROVAL_FILE_THRESHOLD = 4;

export const RISK_APPROVAL_CONTENT_THRESHOLD = 80_000;

export function buildWorkspaceRiskApproval(
  state: AgentRuntimeState,
  changes: WorkerFileChange[],
): InteractiveRequest | null {
  if (!changes.length) return null;

  const sensitiveFiles = changes
    .map((change) => change.filePath)
    .filter((filePath) => SENSITIVE_WORKSPACE_PATH.test(filePath));
  const totalCharacters = changes.reduce(
    (total, change) => total + change.proposedContent.length,
    0,
  );
  const reasons = [
    sensitiveFiles.length
      ? `包含敏感配置或安全相关文件：${sensitiveFiles.join(", ")}`
      : "",
    changes.length > RISK_APPROVAL_FILE_THRESHOLD
      ? `将一次写入 ${changes.length} 个文件`
      : "",
    totalCharacters > RISK_APPROVAL_CONTENT_THRESHOLD
      ? `提案总内容约 ${Math.round(totalCharacters / 1000)}K 字符`
      : "",
  ].filter(Boolean);

  if (!reasons.length) return null;

  const approvalToken = createHash("sha256")
    .update(
      JSON.stringify({
        projectId: state.projectId || "unbound-project",
        request: state.currentUserRequest,
        files: changes.map((change) => [
          change.filePath,
          change.proposedContentHash,
        ]),
      }),
    )
    .digest("hex")
    .slice(0, 24);

  if ((state.approvedRiskActions || []).includes(approvalToken)) return null;

  return {
    id: `workspace-risk-${approvalToken}`,
    source: "risk_approval",
    command: "",
    prompt: "是否允许把这些高风险提案写入正式工作区？",
    mode: "normal",
    kind: "confirm",
    suggestedMode: "user",
    options: [
      { label: "批准写入", value: "approve", index: 0 },
      { label: "拒绝写入", value: "reject", index: 1 },
    ],
    allowMultiple: false,
    promptRound: 1,
    recentOutput: changes.map((change) => change.filePath).join("\n"),
    title: "高风险工作区写入确认",
    description: reasons.join("；"),
    approvalKind: "workspace_write",
    riskLevel: sensitiveFiles.length ? "high" : "medium",
    toolName: "merge_patch",
    toolArguments: {
      files: changes.map((change) => change.filePath),
      totalCharacters,
    },
    approvalToken,
    originalUserRequest: state.currentUserRequest,
  };
}

/**
 * Human-in-the-loop 风险闸门。
 *
 * 普通小范围修改自动通过；敏感文件、大批量文件或超大提案必须由用户确认。
 * 授权令牌绑定当前项目、请求和内容哈希，不能跨任务复用。
 */
export async function workspaceRiskApprovalNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    `risk_approval_${state.reviewIteration || 0}`,
    "merge_agent",
    state.reviewIteration || 0,
    config,
  );
  const workerInteractiveRequest = (state.modifyResults || []).find(
    (result: ModifyTaskResult) => result.interactiveRequest,
  )?.interactiveRequest;
  if (workerInteractiveRequest) {
    tracker.transition(
      "BLOCKED",
      workerInteractiveRequest.description || workerInteractiveRequest.prompt,
    );
    return {
      interactiveRequest: workerInteractiveRequest,
      resumeFromRiskApproval: false,
      approvalResumeTarget: "",
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  const readyChanges = (state.modifyResults || [])
    .flatMap((result: ModifyTaskResult) => result.fileChanges)
    .filter((change: WorkerFileChange) => change.ready);
  const interactiveRequest = buildWorkspaceRiskApproval(state, readyChanges);

  if (interactiveRequest) {
    tracker.transition(
      "BLOCKED",
      interactiveRequest.description || "等待风险审批。",
    );
    return {
      interactiveRequest,
      resumeFromRiskApproval: false,
      approvalResumeTarget: "",
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  tracker.transition("COMPLETED", "工作区写入风险检查通过。");
  return {
    interactiveRequest: null,
    resumeFromRiskApproval: false,
    approvalResumeTarget: "",
    ...buildLifecycleStateUpdate(tracker),
  };
}

// Merge 节点统一负责：合并提案、检测冲突、写入正式文件、汇总结果。
export async function mergePatchNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    `merge_agent_${state.reviewIteration || 0}`,
    "merge_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition(
    "MERGING",
    `正在合并 ${(state.modifyResults || []).length} 个 Worker 结果。`,
  );

  const { mergeResult, interactiveRequest } =
    await mergeParallelWorkerResults(state);
  const touchedFiles = Array.from(
    new Set([
      ...mergeResult.appliedFiles,
      ...mergeResult.alreadyAppliedFiles,
    ]),
  );
  if (mergeResult.status === "success" && touchedFiles.length > 0) {
    const invalidatedEntries = invalidateProjectContextCache(
      state.projectId || "",
    );
    recordAgentTraceEvent("cache", "project_context_invalidation", "info", {
      projectId: state.projectId,
      touchedFiles,
      invalidatedEntries,
    });
  }

  const mergedPatchSummary = [
    `High-Level Plan:\n${JSON.stringify(state.highLevelPlan || [], null, 2)}`,
    `Planner 任务数组:\n${JSON.stringify(state.plannerOutput || [], null, 2)}`,
    `Modify Worker 汇总:\n${formatModifyResults(state.modifyResults || [])}`,
    `Merge 结果:\n${JSON.stringify(mergeResult, null, 2)}`,
  ].join("\n\n");

  if (mergeResult.status === "blocked") {
    tracker.transition("BLOCKED", mergeResult.summary);
  } else if (
    mergeResult.status === "conflict" ||
    mergeResult.status === "failed"
  ) {
    tracker.transition("FAILED", mergeResult.summary);
  } else {
    tracker.transition("COMPLETED", mergeResult.summary);
  }

  return {
    mergeResult,
    mergedPatchSummary,
    touchedFiles,
    interactiveRequest,
    ...buildLifecycleStateUpdate(tracker),
  };
}
