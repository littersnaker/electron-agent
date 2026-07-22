import {
  LlmProviderError,
  type LlmChatResponse,
  type LlmCompletionRequest,
  type LlmContentPart,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderId,
  type LlmStreamChunk,
  type LlmToolCall,
} from "../types";

interface OpenAiCompatibleProviderOptions {
  id: Exclude<LlmProviderId, "gemini">;
  endpoint: string;
}

interface CompatibleToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface CompatibleResponseBody {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: CompatibleToolCall[];
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

interface CompatibleStreamBody {
  choices?: Array<{
    delta?: {
      content?: string;
      reasoning_content?: string;
    };
  }>;
  usage?: CompatibleResponseBody["usage"];
}

function toDataUrl(part: Extract<LlmContentPart, { type: "image" }>): string {
  if (part.url) return part.url;
  return `data:${part.mimeType};base64,${part.data || ""}`;
}

function toCompatibleContent(message: LlmMessage): unknown {
  if (!message.parts?.some((part) => part.type === "image")) {
    return message.content;
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.text) parts.push({ type: "text", text: part.text });
      continue;
    }
    parts.push({
      type: "image_url",
      image_url: { url: toDataUrl(part) },
    });
  }

  if (
    message.content &&
    !message.parts.some(
      (part) => part.type === "text" && part.text === message.content,
    )
  ) {
    parts.unshift({ type: "text", text: message.content });
  }
  return parts;
}

function toCompatibleMessage(message: LlmMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: toCompatibleContent(message),
  };
  if (message.toolCalls?.length) {
    result.tool_calls = message.toolCalls.map((toolCall) => ({
      id: toolCall.id,
      type: "function",
      function: toolCall.function,
    }));
  }
  if (message.toolCallId) result.tool_call_id = message.toolCallId;
  if (message.name) result.name = message.name;
  return result;
}

function normalizeToolCalls(
  values: CompatibleToolCall[] | undefined,
): LlmToolCall[] | undefined {
  if (!values) return undefined;
  const calls = values.flatMap((item): LlmToolCall[] => {
    const name = item.function?.name?.trim();
    if (!name) return [];
    return [
      {
        id: item.id || `tool_${name}_${Date.now()}`,
        type: "function",
        function: {
          name,
          arguments: item.function?.arguments || "{}",
        },
      },
    ];
  });
  return calls.length ? calls : undefined;
}

function buildResponse(
  payload: CompatibleResponseBody,
  request: LlmCompletionRequest,
): LlmChatResponse {
  const message = payload.choices?.[0]?.message;
  return {
    choices: [
      {
        message: {
          content: message?.content ?? null,
          tool_calls: normalizeToolCalls(message?.tool_calls),
        },
      },
    ],
    usage: payload.usage
      ? {
          prompt_tokens: payload.usage.prompt_tokens ?? 0,
          completion_tokens: payload.usage.completion_tokens ?? 0,
          total_tokens:
            payload.usage.total_tokens ??
            (payload.usage.prompt_tokens ?? 0) +
              (payload.usage.completion_tokens ?? 0),
        }
      : undefined,
    route: request.route,
  };
}

async function createProviderError(
  provider: LlmProviderId,
  response: Response,
): Promise<LlmProviderError> {
  const detail = (await response.text()).trim() || `HTTP ${response.status}`;
  return new LlmProviderError({
    provider,
    status: response.status,
    retryable:
      response.status === 408 ||
      response.status === 409 ||
      response.status === 429 ||
      response.status >= 500,
    detail,
  });
}

function buildRequestBody(
  request: LlmCompletionRequest,
  stream: boolean,
): Record<string, unknown> {
  return {
    model: request.route.model,
    messages: request.messages.map(toCompatibleMessage),
    tools: request.tools,
    tool_choice: request.tools?.length
      ? request.toolChoice ?? "auto"
      : undefined,
    stream,
    stream_options: stream ? { include_usage: true } : undefined,
  };
}

/**
 * Qwen、OpenAI、DeepSeek、GLM、Kimi 共用的 Chat Completions 适配器。
 * 各厂商差异被限制在 Provider 注册表和 Endpoint 配置中。
 */
export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: OpenAiCompatibleProviderOptions["id"];
  private readonly endpoint: string;

  constructor(options: OpenAiCompatibleProviderOptions) {
    this.id = options.id;
    this.endpoint = options.endpoint;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmChatResponse> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${request.route.apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(request, false)),
      signal: request.signal,
    });

    if (!response.ok) throw await createProviderError(this.id, response);
    return buildResponse(
      (await response.json()) as CompatibleResponseBody,
      request,
    );
  }

  async *stream(
    request: LlmCompletionRequest,
  ): AsyncIterable<LlmStreamChunk> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${request.route.apiKey}`,
      },
      body: JSON.stringify(buildRequestBody(request, true)),
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      if (!response.ok) throw await createProviderError(this.id, response);
      throw new LlmProviderError({
        provider: this.id,
        retryable: true,
        detail: "响应体为空",
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/u);
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const payload = JSON.parse(data) as CompatibleStreamBody;
          const delta = payload.choices?.[0]?.delta;
          const usage = payload.usage;
          yield {
            textDelta: delta?.content,
            reasoningDelta: delta?.reasoning_content,
            usage: usage
              ? {
                  prompt: usage.prompt_tokens ?? 0,
                  completion: usage.completion_tokens ?? 0,
                  total:
                    usage.total_tokens ??
                    (usage.prompt_tokens ?? 0) +
                      (usage.completion_tokens ?? 0),
                }
              : undefined,
          };
        } catch {
          // 单个无效 SSE 帧不会中断整个流。
        }
      }
    }
  }
}
