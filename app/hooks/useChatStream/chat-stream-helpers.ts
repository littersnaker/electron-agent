"use client";
/**
 * 模块职责：聊天请求内容构建、工作区校验和事件类型守卫。
 */
import type { Dispatch, SetStateAction } from "react";
import type {
  AttachedFile,
  ChatSession,
  CodeAgentExecutionMode,
  Message,
  WorkspaceProject,
} from "../../constants/page-constants";
import type { LlmCredentials, LlmEndpointOverrides } from "../../lib/llm/types";
import type {
  AgentLifecycleEventPayload,
  InteractiveRequest,
  StreamPacket,
  WorkListSnapshotPayload,
} from "../../types/workspace";
import type { AgentCoordinator } from "../useAgentCoordinator";

const MAX_ATTACHMENT_CONTEXT_CHARACTERS = 80_000;

export type PersistSession = (
  session: ChatSession,
  nextMessages: Message[],
  title?: string,
) => Promise<void>;

export interface SubmitPromptOptions {
  /** 交互卡片回复属于内部控制消息，不显示内部协议文本。 */
  suppressVisibleUserMessage?: boolean;
  /** 恢复中断任务时复用已有用户消息，避免重复插入。 */
  resumeExistingRun?: boolean;
  checkpointId?: string;
  resumeCheckpointId?: string;
  modelOverride?: string;
  codeAgentModeOverride?: CodeAgentExecutionMode;
  onCheckpointFinish?: (
    result: import("../../types/checkpoints").CheckpointFinishResult,
  ) => void | Promise<void>;
}

export interface UseChatStreamOptions {
  activeSession?: ChatSession;
  activeProject?: WorkspaceProject;
  messages: Message[];
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setSessions: Dispatch<SetStateAction<ChatSession[]>>;
  persistSession: PersistSession;
  apiKeys: LlmCredentials;
  endpointOverrides: LlmEndpointOverrides;
  selectedModel: string;
  codeAgentMode: CodeAgentExecutionMode;
  attachedFiles: readonly AttachedFile[];
  isParsingFile: boolean;
  clearAfterSubmit: () => void;
  agents: AgentCoordinator;
}

export function buildVisibleUserContent(
  prompt: string,
  attachments: readonly AttachedFile[],
): string {
  if (attachments.length === 0) return prompt;
  if (prompt) return prompt;

  if (attachments.length > 1) {
    return `请分析这 ${attachments.length} 个附件`;
  }

  return attachments[0]?.type.startsWith("image/")
    ? "请分析这张图片"
    : "请分析这份文件";
}

export function buildRequestUserContent(
  prompt: string,
  attachments: readonly AttachedFile[],
): string {
  const textAttachments = attachments.filter(
    (attachment) => !attachment.type.startsWith("image/"),
  );
  if (textAttachments.length === 0) return prompt;

  const sections: string[] = [];
  let remainingCharacters = MAX_ATTACHMENT_CONTEXT_CHARACTERS;

  for (const attachment of textAttachments) {
    const header = `--- ${attachment.relativePath || attachment.name} ---`;
    const content = attachment.textContent || "（未提取到可读文本）";
    const availableContentLength = Math.max(
      0,
      remainingCharacters - header.length - 2,
    );
    const includedContent = content.slice(0, availableContentLength);

    sections.push([header, includedContent].join("\n"));
    remainingCharacters -= header.length + includedContent.length + 2;

    if (includedContent.length < content.length || remainingCharacters <= 0) {
      sections.push("（附件内容已按上下文上限截断）");
      break;
    }
  }

  return [prompt || "请分析这些文件", ...sections].join("\n\n");
}

export function validateCodeWorkspace(
  session: ChatSession,
  project?: WorkspaceProject,
): string | null {
  if (session.mode !== "code") return null;
  if (!project) return "当前 Code 会话绑定的项目不存在，请重新选择项目。";
  if (!project.rootPath.trim()) {
    return "当前 Code 会话没有有效工作目录，请重新添加项目。";
  }
  return null;
}

export async function readResponseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // 非 JSON 错误响应继续使用状态码兜底。
  }
  return `模型请求失败（HTTP ${response.status}）`;
}

export function isAgentLifecyclePayload(
  payload: StreamPacket["payload"],
): payload is AgentLifecycleEventPayload {
  return Boolean(
    payload &&
      "role" in payload &&
      "status" in payload &&
      "iteration" in payload &&
      "detail" in payload,
  );
}

export function isInteractiveRequestPayload(
  payload: StreamPacket["payload"],
): payload is InteractiveRequest {
  return Boolean(payload && "command" in payload && "prompt" in payload);
}

export function isWorkListSnapshotPayload(
  payload: StreamPacket["payload"],
): payload is WorkListSnapshotPayload {
  return Boolean(
    payload &&
      "revision" in payload &&
      "items" in payload &&
      "overallProgress" in payload &&
      Array.isArray(payload.items),
  );
}

export function describeWorkListSnapshot(
  snapshot: WorkListSnapshotPayload,
): string {
  const activeWorks = snapshot.items.filter((item) => item.status === "running");
  if (activeWorks.length > 1) {
    return `并行执行 ${activeWorks.length} 个 Work：${activeWorks
      .map((item) => item.id)
      .join(", ")}`;
  }
  const activeWork = activeWorks[0];
  return activeWork ? `${activeWork.id} · ${activeWork.title}` : snapshot.reason;
}

/** 构造终端或审批交互的内部协议文本，避免在 Hook 中重复拼接。 */
export function buildInteractiveReplyPrompt(
  request: InteractiveRequest,
  mode: "auto" | "llm" | "user",
  fallbackAnswer: string,
  answer?: string,
): string {
  const normalizedAnswer =
    mode === "user"
      ? (answer ?? fallbackAnswer).replace(/\r?\n/g, "")
      : answer;
  const reply =
    mode === "user"
      ? `answer=${normalizedAnswer === "" ? "__ENTER__" : normalizedAnswer}`
      : normalizedAnswer
        ? `answer=${normalizedAnswer}`
        : "";
  return [`[INTERACTIVE_REPLY] id=${request.id} mode=${mode}`, reply]
    .filter(Boolean)
    .join(" ");
}

/** 把交互等待状态同步到右侧 Agent 面板。 */
export function applyInteractiveRequestAgents(
  request: InteractiveRequest,
  agents: AgentCoordinator,
): void {
  if (request.source === "file_create_confirmation") {
    agents.updateAgent("orchestrator", {
      status: "running",
      progress: 38,
      currentTask: "等待确认是否新建缺失文件",
    });
    return;
  }
  if (request.source === "risk_approval" || request.source === "mcp_tool_approval") {
    agents.updateAgent("orchestrator", {
      status: "running",
      progress: 70,
      currentTask: "等待用户批准高风险操作",
    });
    return;
  }
  agents.updateAgent("terminal", {
    status: "running",
    progress: 72,
    currentTask: "等待用户提供终端交互输入",
  });
}

/** 返回交互暂停时写入会话的可见说明。 */
export function interactiveWaitingMessage(request: InteractiveRequest): string {
  if (request.source === "file_create_confirmation") {
    return "需要你确认是否新建缺失文件后才能继续。";
  }
  if (request.source === "risk_approval") {
    return "检测到高风险工作区写入，需要你批准后才能继续。";
  }
  if (request.source === "mcp_tool_approval") {
    return "MCP 工具需要你批准后才能执行。";
  }
  return "终端正在等待你的选择。";
}

