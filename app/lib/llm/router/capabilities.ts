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

/** 统一从规范化后的 message.parts 判断本轮是否含视觉输入。 */
export function hasVisionInput(messages: readonly LlmMessage[]): boolean {
  return messages.some((message) =>
    message.parts?.some((part) => part.type === "image"),
  );
}

export function inferMessageCapabilities(
  messages: readonly LlmMessage[],
): readonly LlmCapability[] {
  return hasVisionInput(messages) ? ["vision"] : [];
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

export function getMissingCapabilities(
  modelCapabilities: readonly LlmCapability[],
  required: readonly LlmCapability[],
): readonly LlmCapability[] {
  return required.filter(
    (capability) => !modelCapabilities.includes(capability),
  );
}
