import {
  LlmProviderError,
  type LlmChatResponse,
  type LlmCompletionRequest,
  type LlmContentPart,
  type LlmFunctionTool,
  type LlmMessage,
  type LlmProvider,
  type LlmStreamChunk,
  type LlmToolCall,
} from "../types";

interface GeminiPart {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
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

function parseDataUrl(
  value: string,
): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/iu.exec(
    value.trim(),
  );
  if (!match) return null;
  return {
    mimeType: match[1] || "image/png",
    data: match[2].replace(/\s+/gu, ""),
  };
}

function toGeminiImagePart(
  part: Extract<LlmContentPart, { type: "image" }>,
): Record<string, unknown> {
  const directData = part.data?.replace(/\s+/gu, "");
  if (directData) {
    return {
      inlineData: {
        mimeType:
          part.mimeType && part.mimeType !== "image/*"
            ? part.mimeType
            : "image/png",
        data: directData,
      },
    };
  }

  const url = part.url?.trim();
  const parsedDataUrl = url ? parseDataUrl(url) : null;
  if (parsedDataUrl) {
    return { inlineData: parsedDataUrl };
  }

  if (url && (url.startsWith("gs://") || url.includes("/files/"))) {
    return {
      fileData: {
        mimeType: part.mimeType || "image/*",
        fileUri: url,
      },
    };
  }

  throw new LlmProviderError({
    provider: "gemini",
    retryable: false,
    detail: url
      ? `图片附件 ${part.name || "未命名图片"} 是普通远程 URL；请先转为 Base64 或通过 Gemini Files API 上传`
      : `图片附件 ${part.name || "未命名图片"} 缺少图片数据`,
  });
}

function toGeminiUserParts(message: LlmMessage): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  const textParts = message.parts?.filter((part) => part.type === "text") || [];
  for (const part of textParts) {
    if (part.type === "text" && part.text) parts.push({ text: part.text });
  }

  if (!textParts.length && message.content) {
    parts.push({ text: message.content });
  }

  for (const part of message.parts || []) {
    if (part.type === "image") parts.push(toGeminiImagePart(part));
  }
  return parts.length ? parts : [{ text: "" }];
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

      return { role: "user", parts: toGeminiUserParts(message) };
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

async function createGeminiError(response: Response): Promise<LlmProviderError> {
  const detail = (await response.text()).trim() || `HTTP ${response.status}`;
  return new LlmProviderError({
    provider: "gemini",
    status: response.status,
    retryable:
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500,
    detail,
  });
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

    if (!response.ok) throw await createGeminiError(response);

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
      if (!response.ok) throw await createGeminiError(response);
      throw new LlmProviderError({
        provider: "gemini",
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
          // 单个无效 SSE 帧不会中断整个流。
        }
      }
    }
  }
}
