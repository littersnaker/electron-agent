import type { BaseMessage } from "@langchain/core/messages";
import type { AgentRequestMode } from "../agent/types";

export interface FrontendMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** 前端传入的 Provider 无关图片附件。 */
export interface FrontendAttachment {
  name: string;
  mimeType: string;
  /** 新格式：纯 Base64，不包含 data: 前缀。 */
  data?: string;
  /** 兼容旧客户端；Route 会在入口处转换为 data。 */
  dataUrl?: string;
}

export interface ChatRequestBody {
  messages?: FrontendMessage[];
  attachments?: FrontendAttachment[];
  sessionId?: string;
  workingDir?: string;
  projectId?: string;
}

export interface AgentStateValues extends Record<string, unknown> {
  messages?: BaseMessage[];
  summary?: string;
  requestMode?: AgentRequestMode;
  directAnswer?: string;
  finalReportSummary?: string;
  tokenUsage?: { prompt: number; completion: number; total: number };
  interactiveRequest?: Record<string, unknown> | null;
}

export interface AgentLifecycleEventPayload {
  id?: string;
  agentId?: string;
  role?: string;
  status?: string;
  detail?: string;
  slot?: number;
  iteration?: number;
  toolName?: string;
  createdAt?: string;
}

export interface StreamDeltaResponse {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}
