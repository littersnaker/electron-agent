// 模块说明：负责 types 核心服务与领域逻辑。
/** Multi-agent 支持的模型供应商。 */
export type LlmProviderId =
  | "qwen"
  | "openai"
  | "gemini"
  | "deepseek"
  | "glm"
  | "kimi"
  | "doubao";

/** Agent Runtime 中的调用场景。 */
export type LlmTaskType =
  | "chat"
  | "read_only"
  | "cli"
  | "memory"
  | "planner"
  | "worker"
  | "reviewer"
  | "reflection"
  | "final_report"
  | "final_answer"
  | "commerce_intent"
  | "commerce_analysis";

/**
 * 模型能力标签。
 *
 * Router 不再把任务硬编码到某个厂商模型，而是先计算任务需要的能力，
 * 再从“已配置凭证且满足能力”的模型池中选择。
 */
export type LlmCapability =
  | "text"
  | "vision"
  | "tool_call"
  | "stream"
  | "reasoning"
  | "coding"
  | "long_context"
  | "fast"
  | "structured_output";

export type LlmMessageRole = "system" | "user" | "assistant" | "tool";

export interface LlmTextPart {
  type: "text";
  text: string;
}

export interface LlmImagePart {
  type: "image";
  mimeType: string;
  /** Base64 数据，不包含 data URL 前缀。 */
  data?: string;
  /** 公网或 data URL。 */
  url?: string;
  name?: string;
}

export type LlmContentPart = LlmTextPart | LlmImagePart;

/** Provider 无关的消息结构。 */
export interface LlmMessage {
  role: LlmMessageRole;
  content: string;
  parts?: readonly LlmContentPart[];
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
  route?: LlmModelRoute;
}

/** 每个 Provider 的 Key 都是可选的，Auto Router 只使用已配置项。 */
export type LlmCredentials = Partial<Record<LlmProviderId, string>>;

/** 用户可覆盖 OpenAI-compatible Provider 的 Base URL。 */
export type LlmEndpointOverrides = Partial<Record<LlmProviderId, string>>;

export interface LlmProviderDefinition {
  id: LlmProviderId;
  name: string;
  environmentKey: string;
  requestHeader: string;
  /** Renderer 发送 Base URL 覆盖时使用的受限请求头。 */
  endpointRequestHeader?: string;
  /** 用于 Electron 持久化和构建时注入的环境变量名。 */
  endpointEnvironmentKey?: string;
  protocol: "openai-compatible" | "gemini";
  defaultEndpoint?: string;
  placeholder: string;
}

export interface LlmModelDefinition {
  /** 前后端传递的稳定逻辑 ID。 */
  id: string;
  provider: LlmProviderId;
  /** 发送给厂商接口的真实模型名。 */
  model: string;
  name: string;
  description: string;
  capabilities: readonly LlmCapability[];
  recommendedTasks: readonly LlmTaskType[];
  /** 综合质量、速度和成本的基础评分，范围建议为 0-100。 */
  quality: number;
  speed: number;
  costEfficiency: number;
  enabledByDefault?: boolean;
  /** false 表示该模型不进入 Auto Router 主候选链。 */
  autoSelect?: boolean;
  /** true 表示模型只作为 Auto Router 的后备候选。 */
  fallbackSelect?: boolean;
  /** Auto Router 数值越小越优先；最近成功模型仍会临时置顶。 */
  autoPriority?: number;
  /** false 表示该模型需要独立媒体生成接口，不能进入 Chat/Gateway 路由。 */
  chatCompatible?: boolean;
}

export interface LlmModelRoute {
  task: LlmTaskType;
  requestedModelId: string;
  modelId: string;
  provider: LlmProviderId;
  model: string;
  apiKey: string;
  reason: string;
  score: number;
  fallbackIndex: number;
  capabilities: readonly LlmCapability[];
}

export interface LlmCompletionRequest {
  route: LlmModelRoute;
  messages: readonly LlmMessage[];
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
  requiredCapabilities?: readonly LlmCapability[];
  signal?: AbortSignal;
}

export interface LlmRouteCandidate {
  model: LlmModelDefinition;
  score: number;
  reason: string;
}

export interface LlmRoutingResult {
  requestedModelId: string;
  requiredCapabilities: readonly LlmCapability[];
  routes: readonly LlmModelRoute[];
}

export interface LlmProviderErrorOptions {
  provider: LlmProviderId;
  status?: number;
  retryable: boolean;
  detail: string;
}

/** Provider 统一错误，供 Gateway 判断是否执行 Fallback。 */
export class LlmProviderError extends Error {
  readonly provider: LlmProviderId;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(options: LlmProviderErrorOptions) {
    super(`${options.provider} 模型调用失败: ${options.detail}`);
    this.name = "LlmProviderError";
    this.provider = options.provider;
    this.status = options.status;
    this.retryable = options.retryable;
  }
}
