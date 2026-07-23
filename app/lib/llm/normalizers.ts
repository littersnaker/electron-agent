import type {
  LlmContentPart,
  LlmFunctionTool,
  LlmImagePart,
  LlmMessage,
  LlmToolCall,
} from "./types";

function readString(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (!Array.isArray(value)) return String(value);

  return value
    .map((item) => {
      if (typeof item === "string") return item;
      if (
        item &&
        typeof item === "object" &&
        "text" in item &&
        typeof item.text === "string"
      ) {
        return item.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function cleanBase64(value: string): string {
  return value.replace(/\s+/gu, "");
}

function parseDataUrl(value: string): LlmImagePart | undefined {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/iu.exec(
    value.trim(),
  );
  if (!match) return undefined;
  return {
    type: "image",
    mimeType: match[1] || "image/png",
    data: cleanBase64(match[2]),
  };
}

function readStringProperty(
  value: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return undefined;
}

function readImagePart(value: Record<string, unknown>): LlmImagePart | undefined {
  const name = readStringProperty(value, "name");

  if (value.type === "image") {
    const rawData = readStringProperty(value, "data");
    const rawUrl = readStringProperty(value, "url", "dataUrl");
    const parsedData = rawData?.startsWith("data:")
      ? parseDataUrl(rawData)
      : undefined;
    const parsedUrl = rawUrl?.startsWith("data:")
      ? parseDataUrl(rawUrl)
      : undefined;

    if (parsedData || parsedUrl) {
      return { ...(parsedData || parsedUrl)!, name };
    }

    if (rawData) {
      return {
        type: "image",
        mimeType:
          readStringProperty(value, "mimeType", "mime_type") || "image/png",
        data: cleanBase64(rawData),
        name,
      };
    }

    if (rawUrl) {
      return {
        type: "image",
        mimeType:
          readStringProperty(value, "mimeType", "mime_type") || "image/*",
        url: rawUrl,
        name,
      };
    }
  }

  if (
    (value.type === "image_url" || value.type === "input_image") &&
    ("image_url" in value || "url" in value)
  ) {
    const raw = "image_url" in value ? value.image_url : value.url;
    const url =
      typeof raw === "string"
        ? raw
        : raw &&
            typeof raw === "object" &&
            "url" in raw &&
            typeof raw.url === "string"
          ? raw.url
          : undefined;
    if (!url) return undefined;

    const parsed = parseDataUrl(url);
    return parsed
      ? { ...parsed, name }
      : {
          type: "image",
          mimeType:
            readStringProperty(value, "mimeType", "mime_type") || "image/*",
          url,
          name,
        };
  }

  return undefined;
}

function readContentParts(value: unknown): LlmContentPart[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const parts = value.flatMap((item): LlmContentPart[] => {
    if (typeof item === "string") {
      return item ? [{ type: "text", text: item }] : [];
    }
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;

    if (record.type === "text" && typeof record.text === "string") {
      return [{ type: "text", text: record.text }];
    }
    const image = readImagePart(record);
    return image ? [image] : [];
  });

  return parts.length ? parts : undefined;
}

function readToolCalls(value: unknown): LlmToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const calls = value.flatMap((item): LlmToolCall[] => {
    if (!item || typeof item !== "object" || !("function" in item)) return [];
    const fn = item.function;
    if (!fn || typeof fn !== "object" || !("name" in fn)) return [];
    const name = typeof fn.name === "string" ? fn.name : "";
    if (!name) return [];
    const args =
      "arguments" in fn && typeof fn.arguments === "string"
        ? fn.arguments
        : JSON.stringify("args" in fn ? fn.args : {});
    const id =
      "id" in item && typeof item.id === "string"
        ? item.id
        : `tool_${name}_${Math.random().toString(36).slice(2, 9)}`;
    return [{ id, type: "function", function: { name, arguments: args } }];
  });

  return calls.length ? calls : undefined;
}

/** 将旧 OpenAI/LangChain 消息归一化为 Provider 无关结构。 */
export function normalizeLlmMessages(
  values: readonly LlmMessage[] | readonly Record<string, unknown>[],
): LlmMessage[] {
  return values.map((value) => {
    const roleValue = "role" in value ? value.role : "user";
    const role =
      roleValue === "system" ||
      roleValue === "assistant" ||
      roleValue === "tool"
        ? roleValue
        : "user";
    const rawContent = "content" in value ? value.content : "";
    const explicitParts =
      "parts" in value && Array.isArray(value.parts)
        ? readContentParts(value.parts)
        : undefined;

    return {
      role,
      content: readString(rawContent),
      // 无论来源是 content 数组还是 parts，都统一重新解析，确保 image_url
      // 会变成 type=image，供 vision 路由和 Provider 适配器共同使用。
      parts: explicitParts || readContentParts(rawContent),
      toolCalls:
        "toolCalls" in value
          ? readToolCalls(value.toolCalls)
          : "tool_calls" in value
            ? readToolCalls(value.tool_calls)
            : undefined,
      toolCallId:
        "toolCallId" in value && typeof value.toolCallId === "string"
          ? value.toolCallId
          : "tool_call_id" in value &&
              typeof value.tool_call_id === "string"
            ? value.tool_call_id
            : undefined,
      name:
        "name" in value && typeof value.name === "string"
          ? value.name
          : undefined,
    };
  });
}

export function normalizeLlmTools(
  values:
    | readonly LlmFunctionTool[]
    | readonly Record<string, unknown>[]
    | undefined,
): LlmFunctionTool[] | undefined {
  if (!values) return undefined;
  const tools = values.flatMap((value): LlmFunctionTool[] => {
    if (!("function" in value) || !value.function) return [];
    const fn = value.function;
    if (
      typeof fn !== "object" ||
      !("name" in fn) ||
      typeof fn.name !== "string"
    ) {
      return [];
    }
    return [
      {
        type: "function",
        function: {
          name: fn.name,
          description:
            "description" in fn && typeof fn.description === "string"
              ? fn.description
              : undefined,
          parameters:
            "parameters" in fn &&
            fn.parameters &&
            typeof fn.parameters === "object" &&
            !Array.isArray(fn.parameters)
              ? (fn.parameters as Record<string, unknown>)
              : undefined,
        },
      },
    ];
  });
  return tools.length ? tools : undefined;
}
