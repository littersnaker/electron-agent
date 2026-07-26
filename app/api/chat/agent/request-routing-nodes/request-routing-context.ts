/**
 * 模块职责：用户请求解析、交互指令识别和新任务状态构建。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { BaseMessage } from "@langchain/core/messages";
import { createHash } from "crypto";
import path from "path";
import { normalizeLlmMessages } from "@/app/lib/llm/normalizers";
import type { LlmContentPart } from "@/app/lib/llm/types";
import type { InteractiveRequest, InteractiveResponseMode, PlannerValidationStatus } from "../types";
import { classifyAgentRequest } from "../request-classifier";
import { AgentState } from "../state";
import { DEFAULT_HIGH_LEVEL_PLAN, DEFAULT_MERGE_RESULT, DEFAULT_PLANNER_PAYLOAD, DEFAULT_REVIEW_PAYLOAD, DEFAULT_VERIFICATION_RESULT } from "../types";
import { buildWorkspaceRuntimeInfo } from "../workspace-context";
export type AgentRuntimeState = typeof AgentState.State;

export type InteractiveReplyInstruction = {
  requestId: string;
  mode: InteractiveResponseMode;
  answer?: string;
};

/** 将 LangChain 消息内容安全转换成纯文本。 */
export function messageContentToText(content: unknown): string {
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
export function getLatestUserRequest(state: AgentRuntimeState): string {
  const humanMessages = state.messages.filter(
    (message: BaseMessage) => message._getType() === "human",
  );
  const latest = humanMessages[humanMessages.length - 1];
  return latest
    ? messageContentToText(latest.content).trim()
    : "请分析当前项目并完成用户请求。";
}

export function getLatestUserImageParts(
  state: AgentRuntimeState,
): LlmContentPart[] {
  const humanMessages = state.messages.filter(
    (message: BaseMessage) => message._getType() === "human",
  );
  const latest = humanMessages[humanMessages.length - 1];
  if (!latest) return [];

  const normalized = normalizeLlmMessages([
    { role: "user", content: latest.content },
  ]);
  return (normalized[0]?.parts || []).filter(
    (part): part is Extract<LlmContentPart, { type: "image" }> =>
      part.type === "image",
  );
}

/** 解析前端交互卡片提交的内部回复，不把它当作新的自然语言任务。 */
export function extractInteractiveReplyInstruction(
  input: string,
): InteractiveReplyInstruction | null {
  const requestIdMatch = input.match(
    /\[INTERACTIVE_REPLY\]\s*id=([^\s]+)\s*/iu,
  );
  const modeMatch = input.match(/\bmode=(auto|llm|user|cancel)\b/iu);
  if (!requestIdMatch || !modeMatch) return null;

  const answerMatch = input.match(/\banswer=([^\n]*)$/iu);
  const rawAnswer = answerMatch?.[1] ?? undefined;

  return {
    requestId: requestIdMatch[1].trim(),
    mode: modeMatch[1].toLowerCase() as InteractiveResponseMode,
    answer: rawAnswer === "__ENTER__" ? "" : rawAnswer,
  };
}

export function isCreateApproval(reply: InteractiveReplyInstruction): boolean {
  if (reply.mode === "cancel") return false;
  if (reply.mode === "auto" || reply.mode === "llm") return true;

  const normalized = (reply.answer || "").trim().toLowerCase();
  return ["create", "yes", "y", "true", "1", "新建", "创建"].includes(
    normalized,
  );
}

/** 解析通用风险审批按钮，只有明确的 approve/确认值才视为授权。 */
export function isRiskApproval(reply: InteractiveReplyInstruction): boolean {
  if (reply.mode === "cancel") return false;
  if (reply.mode === "auto" || reply.mode === "llm") return false;

  const normalized = (reply.answer || "").trim().toLowerCase();
  return ["approve", "yes", "y", "true", "1", "允许", "批准", "确认"].includes(
    normalized,
  );
}

/**
 * 把用户请求中出现的相对路径限制在当前工作区内。
 * Guard 只负责存在性检查，不替代 Worker/Merge 自己的路径安全校验。
 */
export function resolveWorkspaceFilePath(
  filePath: string,
  workingDir: string,
): string | null {
  const rootPath = path.resolve(workingDir);
  const normalized = filePath.replace(/\\/gu, "/").replace(/^\.\//u, "");

  if (!normalized || path.isAbsolute(normalized)) return null;
  const safePath = path.resolve(rootPath, normalized);
  const relativePath = path.relative(rootPath, safePath);

  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return safePath;
}

export function buildFileCreateConfirmation(
  state: AgentRuntimeState,
  filePath: string,
): InteractiveRequest {
  const requestId = createHash("sha1")
    .update(`${state.workingDir}\0${filePath}\0${state.currentUserRequest}`)
    .digest("hex")
    .slice(0, 14);

  return {
    id: `file-create-${requestId}`,
    source: "file_create_confirmation",
    command: "",
    kind: "confirm",
    mode: "normal",
    suggestedMode: "user",
    allowMultiple: false,
    promptRound: 1,
    recentOutput: "",
    filePath,
    originalUserRequest: state.currentUserRequest,
    title: `找不到 ${filePath}`,
    prompt: "要在当前项目中新建这个文件吗？",
    description:
      "确认后，Code Agent 会根据你刚才的要求创建文件并继续执行。现有文件不会因为这一步被覆盖。",
    options: [
      { label: "新建并继续", value: "create", index: 0 },
      { label: "暂不新建", value: "cancel", index: 1 },
    ],
  };
}

export function buildFreshRunState(
  state: AgentRuntimeState,
  currentUserRequest: string,
  approvedMissingFiles: string[],
): Record<string, unknown> {
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
    approvedMissingFiles,
    approvedRiskActions: [],
    resumeFromRiskApproval: false,
    approvalResumeTarget: "",
    evaluationReportId: "",
    evaluationSummary: "",
    // Token 统计按“本轮请求”计算，避免同一 thread 的长期累计污染成本监控。
    tokenUsage: { prompt: 0, completion: 0, total: 0 },
    touchedFiles: [],
    agentLifecycles: {},
    agentLifecycleEvents: [],
    requiresChanges:
      requestMode === "code_change" || requestMode === "simple_edit",
  };
}
