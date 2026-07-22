/** 支持的模型供应商。 */
export type LlmProviderId = "qwen" | "openai" | "gemini";

/** Model Router 用于区分不同调用场景。 */
export type LlmTaskType =
  | "chat"
  | "read_only"
  | "cli"
  | "memory"
  | "planner"
  | "worker"
  | "reviewer"
  | "final_report"
  | "final_answer";

export type LlmMessageRole = "system" | "user" | "assistant" | "tool";

export interface LlmToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

/**
 * 网关使用的统一消息结构。
 *
 * `toolCalls` 和 `toolCallId` 让 OpenAI 兼容协议与 Gemini 的函数调用协议
 * 可以在 Provider 内部互相转换，上层 Agent 不再依赖具体厂商格式。
 */
export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
  toolCalls?: LlmToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface LlmFunctionTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface LlmTokenUsage {
  prompt: number;
  completion: number;
  total: number;
}

export interface LlmChatResponse {
  choices: Array<{
    message: {
      content: string | null;
      tool_calls?: LlmToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  route: LlmModelRoute;
}

export interface LlmStreamChunk {
  textDelta?: string;
  reasoningDelta?: string;
  usage?: LlmTokenUsage;
}

export interface LlmCredentials {
  qwen?: string;
  openai?: string;
  gemini?: string;
}

export interface LlmModelDefinition {
  /** 前后端传递的稳定逻辑 ID，不直接等同于厂商 model 字段。 */
  id: string;
  provider: LlmProviderId;
  model: string;
  name: string;
  description: string;
  supportsTools: boolean;
  recommendedTasks: readonly LlmTaskType[];
}

export interface LlmModelRoute {
  task: LlmTaskType;
  requestedModelId: string;
  modelId: string;
  provider: LlmProviderId;
  model: string;
  apiKey: string;
  reason: string;
}

export interface LlmCompletionRequest {
  route: LlmModelRoute;
  messages: readonly LlmMessage[];
  tools?: readonly LlmFunctionTool[];
  toolChoice?: "auto" | "none";
  signal?: AbortSignal;
}

export interface LlmProvider {
  readonly id: LlmProviderId;
  complete(request: LlmCompletionRequest): Promise<LlmChatResponse>;
  stream(request: LlmCompletionRequest): AsyncIterable<LlmStreamChunk>;
}

export interface LlmGatewayRequest {
  task: LlmTaskType;
  preferredModelId?: string;
  credentials?: LlmCredentials;
  messages: readonly LlmMessage[] | readonly Record<string, unknown>[];
  tools?: readonly LlmFunctionTool[] | readonly Record<string, unknown>[];
  toolChoice?: "auto" | "none";
  signal?: AbortSignal;
}
