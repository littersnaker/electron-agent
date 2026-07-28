"use client";
/**
 * 模块职责：聊天请求内容构建、工作区校验和事件类型守卫。
 */
import type { Dispatch, SetStateAction } from "react";
import type {
  AttachedFile,
  ChatSession,
  Message,
  WorkspaceProject,
} from "../../constants/page-constants";
import type { LlmCredentials } from "../../lib/llm/types";
import type {
  AgentLifecycleEventPayload,
  InteractiveRequest,
  StreamPacket,
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
}

export interface UseChatStreamOptions {
  activeSession?: ChatSession;
  activeProject?: WorkspaceProject;
  messages: Message[];
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setSessions: Dispatch<SetStateAction<ChatSession[]>>;
  persistSession: PersistSession;
  apiKeys: LlmCredentials;
  selectedModel: string;
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
