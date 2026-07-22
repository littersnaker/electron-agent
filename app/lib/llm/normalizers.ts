import type {
  LlmFunctionTool,
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

/** 将旧的 OpenAI 风格 Record 消息归一化为 Provider 无关消息。 */
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

    return {
      role,
      content: readString("content" in value ? value.content : ""),
      toolCalls:
        "toolCalls" in value
          ? readToolCalls(value.toolCalls)
          : "tool_calls" in value
            ? readToolCalls(value.tool_calls)
            : undefined,
      toolCallId:
        "toolCallId" in value && typeof value.toolCallId === "string"
          ? value.toolCallId
          : "tool_call_id" in value && typeof value.tool_call_id === "string"
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
  values: readonly LlmFunctionTool[] | readonly Record<string, unknown>[] | undefined,
): LlmFunctionTool[] | undefined {
  if (!values) return undefined;
  const tools = values.flatMap((value): LlmFunctionTool[] => {
    if (!("function" in value) || !value.function) return [];
    const fn = value.function;
    if (typeof fn !== "object" || !("name" in fn) || typeof fn.name !== "string") {
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
