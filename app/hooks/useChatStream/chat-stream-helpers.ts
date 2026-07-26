"use client";
/**
 * 模块职责：聊天请求内容构建、工作区校验和事件类型守卫。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { Dispatch, SetStateAction } from "react";
import type { AttachedFile, ChatSession, Message, WorkspaceProject } from "../../constants/page-constants";
import type { LlmCredentials } from "../../lib/llm/types";
import type { AgentLifecycleEventPayload, InteractiveRequest, StreamPacket } from "../../types/workspace";
import type { AgentCoordinator } from "../useAgentCoordinator";
export type PersistSession = (
  session: ChatSession,
  nextMessages: Message[],
  title?: string,
) => Promise<void>;

export interface SubmitPromptOptions {
  /**
   * 交互卡片回复属于内部控制消息，不应把 [INTERACTIVE_REPLY] 技术文本显示到聊天记录。
   */
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
  attachedFile: AttachedFile | null;
  isParsingFile: boolean;
  clearAfterSubmit: () => void;
  agents: AgentCoordinator;
}

export function buildVisibleUserContent(
  prompt: string,
  attachment: AttachedFile | null,
): string {
  if (!attachment) return prompt;
  return prompt ||
    (attachment.type.startsWith("image/")
      ? "请分析这张图片"
      : "请分析这份文件");
}

export function buildRequestUserContent(
  prompt: string,
  attachment: AttachedFile | null,
): string {
  if (!attachment || attachment.type.startsWith("image/")) return prompt;

  return [
    prompt || "请分析这份文件",
    `--- ${attachment.name} ---`,
    attachment.textContent || "",
  ].join("\n\n");
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
