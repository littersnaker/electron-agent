import type {
  LlmCapability,
  LlmMessage,
  LlmTaskType,
} from "../types";

const TASK_CAPABILITIES: Record<
  LlmTaskType,
  readonly LlmCapability[]
> = {
  chat: ["text", "stream"],
  read_only: ["text", "long_context"],
  cli: ["text", "fast"],
  memory: ["text", "long_context", "structured_output"],
  planner: ["text", "reasoning", "structured_output"],
  worker: ["text", "coding", "tool_call"],
  reviewer: ["text", "reasoning", "coding", "structured_output"],
  final_report: ["text", "reasoning", "structured_output"],
  final_answer: ["text", "stream"],
};

export function getTaskCapabilities(
  task: LlmTaskType,
): readonly LlmCapability[] {
  return TASK_CAPABILITIES[task];
}

export function inferMessageCapabilities(
  messages: readonly LlmMessage[],
): readonly LlmCapability[] {
  const hasImage = messages.some((message) =>
    message.parts?.some((part) => part.type === "image"),
  );
  return hasImage ? ["vision"] : [];
}

export function mergeCapabilities(
  ...groups: ReadonlyArray<readonly LlmCapability[] | undefined>
): readonly LlmCapability[] {
  return Array.from(new Set(groups.flatMap((group) => group || [])));
}

export function modelSupportsCapabilities(
  modelCapabilities: readonly LlmCapability[],
  required: readonly LlmCapability[],
): boolean {
  return required.every((capability) =>
    modelCapabilities.includes(capability),
  );
}
