import type { BaseMessage } from "@langchain/core/messages";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { completeWithLlm } from "@/app/lib/llm/gateway";
import { normalizeLlmMessages } from "@/app/lib/llm/normalizers";
import type { LlmContentPart } from "@/app/lib/llm/types";
import { getRequestLlmCredentials } from "@/app/lib/llm/request-context";
import { ReadOnlyPromptText } from "../prompt";
import type {
  InteractiveRequest,
  InteractiveResponseMode,
  PlannerValidationStatus,
} from "./types";
import {
  classifyAgentRequest,
  extractExistingFileMutationTargets,
  extractSimpleEditFiles,
} from "./request-classifier";
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

type InteractiveReplyInstruction = {
  requestId: string;
  mode: InteractiveResponseMode;
  answer?: string;
};

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

function getLatestUserImageParts(
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
function extractInteractiveReplyInstruction(
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

function isCreateApproval(reply: InteractiveReplyInstruction): boolean {
  if (reply.mode === "cancel") return false;
  if (reply.mode === "auto" || reply.mode === "llm") return true;

  const normalized = (reply.answer || "").trim().toLowerCase();
  return ["create", "yes", "y", "true", "1", "新建", "创建"].includes(
    normalized,
  );
}

/**
 * 把用户请求中出现的相对路径限制在当前工作区内。
 * Guard 只负责存在性检查，不替代 Worker/Merge 自己的路径安全校验。
 */
function resolveWorkspaceFilePath(
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

function buildFileCreateConfirmation(
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

function buildFreshRunState(
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
    touchedFiles: [],
    agentLifecycles: {},
    agentLifecycleEvents: [],
    requiresChanges:
      requestMode === "code_change" || requestMode === "simple_edit",
  };
}

/**
 * V6 Router：重置本轮瞬态状态，并处理缺失文件确认卡片的恢复逻辑。
 *
 * 文件确认回复不会作为新的用户需求进入 Planner。点击“新建并继续”后会恢复
 * 原始请求，并把对应文件写入 approvedMissingFiles；点击“暂不新建”则直接结束本轮。
 */
export function requestRouterNode(
  state: AgentRuntimeState,
): Record<string, unknown> {
  const latestUserRequest = getLatestUserRequest(state);
  const replyInstruction = extractInteractiveReplyInstruction(latestUserRequest);
  const pendingRequest = state.interactiveRequest;

  if (
    replyInstruction &&
    pendingRequest?.source === "file_create_confirmation" &&
    pendingRequest.id === replyInstruction.requestId
  ) {
    const originalUserRequest =
      pendingRequest.originalUserRequest?.trim() || state.currentUserRequest;
    const filePath = pendingRequest.filePath?.trim() || "目标文件";

    if (isCreateApproval(replyInstruction)) {
      const approvedMissingFiles = Array.from(
        new Set([...(state.approvedMissingFiles || []), filePath]),
      );
      return buildFreshRunState(
        state,
        originalUserRequest,
        approvedMissingFiles,
      );
    }

    return {
      ...buildFreshRunState(state, originalUserRequest, []),
      requestMode: "read_only",
      requiresChanges: false,
      directAnswer: `好的，暂不新建 \`${filePath}\`。这次修改已取消，项目中的现有文件不会被改动。`,
    };
  }

  // 普通新任务必须清空上一轮“允许创建”的授权，防止跨任务复用。
  return buildFreshRunState(state, latestUserRequest, []);
}

/** 只作为并行 Search / Memory / File 的稳定分发点。 */
export function contextFanoutNode(): Record<string, never> {
  return {};
}

/**
 * 在真正进入 Planner/Worker 之前检查用户明确指定的“既有文件修改目标”。
 *
 * 文件不存在时不会直接创建，而是向前端发一个确认请求；用户确认后本节点再次执行，
 * 看到 approvedMissingFiles 中已有授权才允许流程继续。
 */
export function missingFileGuardNode(
  state: AgentRuntimeState,
): Record<string, unknown> {
  if (
    state.requestMode !== "simple_edit" &&
    state.requestMode !== "code_change"
  ) {
    return { interactiveRequest: null };
  }

  const targets = extractExistingFileMutationTargets(state.currentUserRequest);
  if (!targets.length) return { interactiveRequest: null };

  const approved = new Set(
    (state.approvedMissingFiles || []).map((item) =>
      item.replace(/\\/gu, "/").replace(/^\.\//u, ""),
    ),
  );

  for (const filePath of targets) {
    const normalized = filePath.replace(/\\/gu, "/").replace(/^\.\//u, "");
    if (approved.has(normalized)) continue;

    const safePath = resolveWorkspaceFilePath(normalized, state.workingDir);
    if (!safePath || fs.existsSync(safePath)) continue;

    return {
      interactiveRequest: buildFileCreateConfirmation(state, normalized),
    };
  }

  return { interactiveRequest: null };
}

/**
 * 为明确的单文档修改生成确定性单任务计划。
 *
 * simple_edit 不需要 High-Level Planner / Task Planner，也不需要 Search/Memory/File
 * 三路上下文收集；Worker 仍会在真正修改前读取磁盘文件，并按需查看 package.json
 * 或目录结构，因此安全边界不变，但能显著减少模型轮次。
 */
export function simpleEditPlanningNode(
  state: AgentRuntimeState,
): Record<string, unknown> {
  const files = extractSimpleEditFiles(state.currentUserRequest);
  const targetFile = files[0];

  if (!targetFile) {
    // 理论上 Router 已经保证 simple_edit 至少命中一个文件。
    // 这里保留兜底，避免分类规则未来调整后生成空文件任务。
    return {
      requestMode: "code_change",
      plannerOutput: DEFAULT_PLANNER_PAYLOAD,
      plannerValidationStatus: "pending" as PlannerValidationStatus,
      plannerValidationMessage:
        "simple_edit 未提取到明确目标文件，回退到完整 Planner 链路。",
    };
  }

  const approvedForCreation = (state.approvedMissingFiles || []).includes(
    targetFile,
  );
  const plan = [
    {
      id: "simple_edit_1",
      parentId: "simple_edit",
      task: state.currentUserRequest,
      files: [targetFile],
      reason: "用户明确指定单个文档文件，使用轻量修改链路。",
      acceptanceCriteria: [
        `只修改 ${targetFile}，除非用户需求明确要求其他文件。`,
        "内容必须完整覆盖用户需求，不得虚构项目技术栈或目录。",
        "需要描述技术栈或目录时，先读取 package.json 和相关目录确认事实。",
        approvedForCreation
          ? `用户已确认：如果 ${targetFile} 不存在，可以新建该文件。`
          : `如果 ${targetFile} 不存在，必须先经过缺失文件确认流程。`,
        "完成后必须生成可合并文件提案并由 Merge 统一落盘。",
      ],
      priority: "high" as const,
    },
  ];

  return {
    highLevelPlanRawOutput: "",
    highLevelPlan: [
      {
        id: "simple_edit",
        objective: state.currentUserRequest,
        scope: [targetFile],
        rationale: "单文件文档修改无需启动两层 Planner。",
        dependencies: [],
        priority: "high" as const,
      },
    ],
    highLevelPlanSummary: `轻量修改：${targetFile}`,
    plannerOutput: plan,
    plannerRawOutput: JSON.stringify(plan, null, 2),
    plannerValidationStatus: "files_unique" as PlannerValidationStatus,
    plannerValidationMessage: "simple_edit 已生成单文件确定性计划。",
    structuredTaskListSummary: [
      "执行模式: simple_edit",
      `目标文件: ${targetFile}`,
      approvedForCreation ? "缺失文件授权: 已允许新建" : "缺失文件授权: 不需要",
      `用户需求: ${state.currentUserRequest}`,
    ].join("\n"),
    requiresChanges: true,
  };
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
  const content = [
    `用户问题：\n${state.currentUserRequest}`,
    `项目上下文：\n${state.mergedContext}`,
  ].join("\n\n");
  const imageParts = getLatestUserImageParts(state);

  const payload = await completeWithLlm({
    task: "read_only",
    preferredModelId: state.model,
    credentials: getRequestLlmCredentials(),
    messages: [
      { role: "system", content: ReadOnlyPromptText },
      {
        role: "user",
        content,
        parts: imageParts.length
          ? [{ type: "text", text: content }, ...imageParts]
          : undefined,
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
