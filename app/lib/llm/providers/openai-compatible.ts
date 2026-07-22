import type {
  LlmChatResponse,
  LlmCompletionRequest,
  LlmMessage,
  LlmProvider,
  LlmProviderId,
  LlmStreamChunk,
  LlmToolCall,
} from "../types";

interface OpenAiCompatibleProviderOptions {
  id: Extract<LlmProviderId, "qwen" | "openai">;
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

function toCompatibleMessage(message: LlmMessage): Record<string, unknown> {
  const result: Record<string, unknown> = {
    role: message.role,
    content: message.content,
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

async function readProviderError(response: Response): Promise<string> {
  const detail = (await response.text()).trim();
  return detail || `HTTP ${response.status}`;
}

/** OpenAI 与千问 OpenAI-compatible Chat Completions 的共享实现。 */
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
      body: JSON.stringify({
        model: request.route.model,
        messages: request.messages.map(toCompatibleMessage),
        tools: request.tools,
        tool_choice: request.tools?.length
          ? request.toolChoice ?? "auto"
          : undefined,
        stream: false,
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      throw new Error(
        `${this.id} 模型调用失败: ${await readProviderError(response)}`,
      );
    }

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
      body: JSON.stringify({
        model: request.route.model,
        messages: request.messages.map(toCompatibleMessage),
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `${this.id} 流式调用失败: ${await readProviderError(response)}`,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
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
          // 单个无效 SSE 帧不影响后续帧解析。
        }
      }
    }
  }
}
