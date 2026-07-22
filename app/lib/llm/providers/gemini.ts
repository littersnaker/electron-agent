import type {
  LlmChatResponse,
  LlmCompletionRequest,
  LlmFunctionTool,
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
  LlmToolCall,
} from "../types";

interface GeminiPart {
  text?: string;
  functionCall?: { name?: string; args?: Record<string, unknown> };
}

interface GeminiResponseBody {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] };
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  error?: { message?: string };
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function buildToolNameMap(messages: readonly LlmMessage[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls || []) {
      result.set(call.id, call.function.name);
    }
  }
  return result;
}

function toGeminiContents(messages: readonly LlmMessage[]) {
  const toolNames = buildToolNameMap(messages);
  return messages
    .filter((message) => message.role !== "system")
    .map((message) => {
      if (message.role === "assistant") {
        const parts: Array<Record<string, unknown>> = [];
        if (message.content) parts.push({ text: message.content });
        for (const call of message.toolCalls || []) {
          parts.push({
            functionCall: {
              name: call.function.name,
              args: parseJsonObject(call.function.arguments),
            },
          });
        }
        return { role: "model", parts: parts.length ? parts : [{ text: "" }] };
      }

      if (message.role === "tool") {
        const name =
          message.name ||
          (message.toolCallId ? toolNames.get(message.toolCallId) : undefined) ||
          "tool_result";
        return {
          role: "user",
          parts: [
            {
              functionResponse: {
                name,
                response: { result: message.content },
              },
            },
          ],
        };
      }

      return { role: "user", parts: [{ text: message.content }] };
    });
}

function toGeminiTools(tools: readonly LlmFunctionTool[] | undefined) {
  if (!tools?.length) return undefined;
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
      })),
    },
  ];
}

function readSystemInstruction(messages: readonly LlmMessage[]) {
  const text = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .filter(Boolean)
    .join("\n\n");
  return text ? { parts: [{ text }] } : undefined;
}

function toUsage(payload: GeminiResponseBody) {
  const usage = payload.usageMetadata;
  if (!usage) return undefined;
  return {
    prompt_tokens: usage.promptTokenCount ?? 0,
    completion_tokens: usage.candidatesTokenCount ?? 0,
    total_tokens:
      usage.totalTokenCount ??
      (usage.promptTokenCount ?? 0) + (usage.candidatesTokenCount ?? 0),
  };
}

function parseGeminiContent(payload: GeminiResponseBody): {
  content: string | null;
  toolCalls?: LlmToolCall[];
} {
  const parts = payload.candidates?.[0]?.content?.parts || [];
  const content = parts
    .map((part) => part.text || "")
    .filter(Boolean)
    .join("");
  const toolCalls = parts.flatMap((part, index): LlmToolCall[] => {
    const name = part.functionCall?.name?.trim();
    if (!name) return [];
    return [
      {
        id: `gemini_${name}_${Date.now()}_${index}`,
        type: "function",
        function: {
          name,
          arguments: JSON.stringify(part.functionCall?.args || {}),
        },
      },
    ];
  });
  return {
    content: content || null,
    toolCalls: toolCalls.length ? toolCalls : undefined,
  };
}

function buildRequestBody(request: LlmCompletionRequest) {
  return {
    systemInstruction: readSystemInstruction(request.messages),
    contents: toGeminiContents(request.messages),
    tools: toGeminiTools(request.tools),
    toolConfig: request.tools?.length
      ? {
          functionCallingConfig: {
            mode: request.toolChoice === "none" ? "NONE" : "AUTO",
          },
        }
      : undefined,
  };
}

async function readGeminiError(response: Response): Promise<string> {
  const detail = (await response.text()).trim();
  return detail || `HTTP ${response.status}`;
}

/** Gemini generateContent / streamGenerateContent 协议适配器。 */
export class GeminiProvider implements LlmProvider {
  readonly id = "gemini" as const;

  async complete(request: LlmCompletionRequest): Promise<LlmChatResponse> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      request.route.model,
    )}:generateContent`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": request.route.apiKey,
      },
      body: JSON.stringify(buildRequestBody(request)),
      signal: request.signal,
    });

    if (!response.ok) {
      throw new Error(`Gemini 调用失败: ${await readGeminiError(response)}`);
    }

    const payload = (await response.json()) as GeminiResponseBody;
    const parsed = parseGeminiContent(payload);
    return {
      choices: [
        {
          message: {
            content: parsed.content,
            tool_calls: parsed.toolCalls,
          },
        },
      ],
      usage: toUsage(payload),
      route: request.route,
    };
  }

  async *stream(
    request: LlmCompletionRequest,
  ): AsyncIterable<LlmStreamChunk> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
      request.route.model,
    )}:streamGenerateContent?alt=sse`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": request.route.apiKey,
      },
      body: JSON.stringify(buildRequestBody(request)),
      signal: request.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `Gemini 流式调用失败: ${await readGeminiError(response)}`,
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
        if (!data) continue;
        try {
          const payload = JSON.parse(data) as GeminiResponseBody;
          const parsed = parseGeminiContent(payload);
          const usage = toUsage(payload);
          yield {
            textDelta: parsed.content || undefined,
            usage: usage
              ? {
                  prompt: usage.prompt_tokens,
                  completion: usage.completion_tokens,
                  total: usage.total_tokens,
                }
              : undefined,
          };
        } catch {
          // 忽略单个无效 SSE 数据帧。
        }
      }
    }
  }
}
