import type { BaseMessage } from "@langchain/core/messages";
import { completeWithLlm } from "@/app/lib/llm/gateway";
import { getRequestLlmCredentials } from "@/app/lib/llm/request-context";
import { ReadOnlyPromptText } from "../prompt";
import type { PlannerValidationStatus } from "./types";
import { classifyAgentRequest } from "./request-classifier";
import { AgentState } from "./state";
import {
  DEFAULT_HIGH_LEVEL_PLAN,
  DEFAULT_MERGE_RESULT,
  DEFAULT_PLANNER_PAYLOAD,
  DEFAULT_REVIEW_PAYLOAD,
  DEFAULT_VERIFICATION_RESULT,
} from "./types";
import {
  buildWorkspaceRuntimeInfo,
  formatWorkspaceContext,
} from "./workspace-context";

type AgentRuntimeState = typeof AgentState.State;

/** 将 LangChain 消息内容安全转换成纯文本。 */
function messageContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return String(content ?? "");

  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (
        item &&
        typeof item === "object" &&
        "text" in item &&
        typeof item.text === "string"
      ) {
        return item.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/** 读取当前轮最后一条用户消息，避免把旧会话内容误当成新任务。 */
function getLatestUserRequest(state: AgentRuntimeState): string {
  const humanMessages = state.messages.filter(
    (message: BaseMessage) => message._getType() === "human",
  );
  const latest = humanMessages[humanMessages.length - 1];
  return latest
    ? messageContentToText(latest.content).trim()
    : "请分析当前项目并完成用户请求。";
}

/**
 * V5 Router：重置本轮瞬态状态，并给图写入 requestMode 和工作区信息。
 * 旧的 Planner / Worker 节点继续复用，不在超大 workflow-nodes.ts 中堆新逻辑。
 */
export function requestRouterNode(
  state: AgentRuntimeState,
): Record<string, unknown> {
  const currentUserRequest = getLatestUserRequest(state);
  const requestMode = classifyAgentRequest(currentUserRequest);
  const workspaceInfo = buildWorkspaceRuntimeInfo(
    state.workingDir,
    state.projectId,
  );

  return {
    currentUserRequest,
    requestMode,
    workspaceInfo,
    directAnswer: "",
    verificationResult: DEFAULT_VERIFICATION_RESULT,
    lintSummary: "",
    finalReportSummary: "",
    mergedContext: "",
    searchContext: "",
    memoryContext: "",
    fileContext: "",
    highLevelPlanRawOutput: "",
    highLevelPlan: DEFAULT_HIGH_LEVEL_PLAN,
    highLevelPlanSummary: "",
    plannerOutput: DEFAULT_PLANNER_PAYLOAD,
    plannerRawOutput: "",
    plannerValidationStatus: "pending" as PlannerValidationStatus,
    plannerValidationMessage: "",
    plannerRetryCount: 0,
    plannerRetryReason: "",
    modifyResults: [],
    mergeResult: DEFAULT_MERGE_RESULT,
    mergedPatchSummary: "",
    structuredTaskListSummary: "",
    reviewPayload: DEFAULT_REVIEW_PAYLOAD,
    reviewFeedback: "",
    reviewDecision: "PASS",
    retryTaskSlots: [],
    reviewIteration: 0,
    interactiveRequest: null,
    touchedFiles: [],
    agentLifecycles: {},
    agentLifecycleEvents: [],
    requiresChanges: requestMode === "code_change",
  };
}

/** 只作为并行 Search / Memory / File 的稳定分发点。 */
export function contextFanoutNode(): Record<string, never> {
  return {};
}

/** 将本地工作区信息附加到三路上下文之后，供只读回答和代码链路复用。 */
export function enrichContextNode(
  state: AgentRuntimeState,
): Record<string, unknown> {
  const workspaceInfo =
    state.workspaceInfo ??
    buildWorkspaceRuntimeInfo(state.workingDir, state.projectId);
  const workspaceContext = formatWorkspaceContext(workspaceInfo);

  return {
    workspaceInfo,
    mergedContext: [
      `Workspace:\n${workspaceContext}`,
      state.mergedContext || "暂无项目上下文。",
    ].join("\n\n"),
  };
}

/** 工作区元信息由本地代码直接回答，不调用模型，也不运行 Planner。 */
export function workspaceInfoAnswerNode(
  state: AgentRuntimeState,
): Record<string, unknown> {
  const workspaceInfo =
    state.workspaceInfo ??
    buildWorkspaceRuntimeInfo(state.workingDir, state.projectId);

  return {
    directAnswer: formatWorkspaceContext(workspaceInfo),
  };
}

/**
 * 只读请求只基于检索上下文回答，不允许声称执行了文件修改。
 * 该节点和完整 Code Agent 使用同一个模型配置，但不会挂载写入工具。
 */
export async function readOnlyAnswerNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const payload = await completeWithLlm({
    task: "read_only",
    preferredModelId: state.model,
    credentials: getRequestLlmCredentials(),
    messages: [
      { role: "system", content: ReadOnlyPromptText },
      {
        role: "user",
        content: [
          `用户问题：\n${state.currentUserRequest}`,
          `项目上下文：\n${state.mergedContext}`,
        ].join("\n\n"),
      },
    ],
  });

  const directAnswer = payload.choices?.[0]?.message?.content?.trim();
  if (!directAnswer) {
    throw new Error("只读回答模型没有返回有效内容");
  }

  return {
    directAnswer,
    tokenUsage: {
      prompt: payload.usage?.prompt_tokens ?? 0,
      completion: payload.usage?.completion_tokens ?? 0,
      total: payload.usage?.total_tokens ?? 0,
    },
  };
}
