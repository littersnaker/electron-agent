import type {
  LlmCapability,
  LlmModelDefinition,
  LlmProviderId,
  LlmTaskType,
} from "../types";

export const AUTO_MODEL_ID = "auto";
export const DEFAULT_MODEL_ID = "qwen:qwen3.7-max";

const ALL_TEXT_TASKS: readonly LlmTaskType[] = [
  "chat",
  "read_only",
  "cli",
  "memory",
  "planner",
  "worker",
  "reviewer",
  "final_report",
  "final_answer",
];

const TEXT_AGENT_CAPABILITIES: readonly LlmCapability[] = [
  "text",
  "stream",
  "tool_call",
  "reasoning",
  "coding",
  "long_context",
  "structured_output",
];

/**
 * V7 模型注册表。
 *
 * 新模型只需要登记 Provider、厂商模型名、能力和基础评分。
 * Agent 节点不再维护模型名称或降级链。
 */
export const LLM_MODEL_CATALOG: readonly LlmModelDefinition[] = [
  {
    id: DEFAULT_MODEL_ID,
    provider: "qwen",
    model: "qwen3.7-max",
    name: "Qwen 3.7 Max",
    description: "默认代码与复杂任务模型",
    capabilities: TEXT_AGENT_CAPABILITIES,
    recommendedTasks: ALL_TEXT_TASKS,
    quality: 88,
    speed: 72,
    costEfficiency: 78,
  },
  {
    id: "Qwen 3.7 Max Preview",
    provider: "qwen",
    model: "7-max-27-max-2026-06-08",
    name: "Qwen 3.7 Max Preview",
    description: "默认代码与复杂任务模型预览",
    capabilities: TEXT_AGENT_CAPABILITIES,
    recommendedTasks: ALL_TEXT_TASKS,
    quality: 88,
    speed: 72,
    costEfficiency: 78,
  },
  {
    id: "百炼 GLM-5.2",
    provider: "qwen",
    model: "glm-5.2",
    name: "百炼 GLM-5.2",
    description: "默认代码与复杂任务模型",
    capabilities: TEXT_AGENT_CAPABILITIES,
    recommendedTasks: ALL_TEXT_TASKS,
    quality: 88,
    speed: 72,
    costEfficiency: 78,
  },
  {
    id: "百炼 K2.7 Code",
    provider: "qwen",
    model: "kimi-k2.7-code",
    name: "百炼 K2.7 Code",
    description: "默认代码与复杂任务模型",
    capabilities: TEXT_AGENT_CAPABILITIES,
    recommendedTasks: ALL_TEXT_TASKS,
    quality: 88,
    speed: 72,
    costEfficiency: 78,
  },
  {
    id: "百炼 V4 Pro",
    provider: "qwen",
    model: "deepseek-v4-pro",
    name: "百炼 V4 Pro",
    description: "默认代码与复杂任务模型",
    capabilities: TEXT_AGENT_CAPABILITIES,
    recommendedTasks: ALL_TEXT_TASKS,
    quality: 88,
    speed: 72,
    costEfficiency: 78,
  },
  {
    id: "qwen:qwen3.7-plus",
    provider: "qwen",
    model: "qwen3.7-plus-2026-05-26",
    name: "Qwen 3.7 Plus",
    description: "快速问答、摘要和常规代码任务",
    capabilities: [
      "text",
      "stream",
      "tool_call",
      "coding",
      "long_context",
      "fast",
      "structured_output",
    ],
    recommendedTasks: ["chat", "read_only", "cli", "memory", "final_answer"],
    quality: 80,
    speed: 88,
    costEfficiency: 88,
  },
  {
    id: "qwen:qwen-vl-max",
    provider: "qwen",
    model: "wan2.7-t2v-2026-06-12",
    name: "Qwen VL Max",
    description: "界面截图、视觉理解和图文分析",
    capabilities: ["text", "vision", "stream", "reasoning", "long_context"],
    recommendedTasks: ["chat", "read_only", "final_answer"],
    quality: 84,
    speed: 70,
    costEfficiency: 75,
  },
  {
    id: "openai:gpt-5.1",
    provider: "openai",
    model: "gpt-5.1",
    name: "OpenAI GPT-5.1",
    description: "规划、审查、代码和多模态任务",
    capabilities: [...TEXT_AGENT_CAPABILITIES, "vision"],
    recommendedTasks: ALL_TEXT_TASKS,
    quality: 94,
    speed: 66,
    costEfficiency: 48,
  },
  {
    id: "gemini:gemini-3.6-flash",
    provider: "gemini",
    model: "gemini-3.6-flash",
    name: "Gemini 3.6 Flash",
    description: "快速长上下文和多模态分析",
    capabilities: [
      "text",
      "vision",
      "stream",
      "tool_call",
      "reasoning",
      "coding",
      "long_context",
      "fast",
      "structured_output",
    ],
    recommendedTasks: ["chat", "read_only", "cli", "memory", "final_answer"],
    quality: 86,
    speed: 94,
    costEfficiency: 90,
  },
  {
    id: "deepseek:deepseek-v4-pro",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro",
    description: "复杂推理、代码修改和审查",
    capabilities: TEXT_AGENT_CAPABILITIES,
    recommendedTasks: ["planner", "worker", "reviewer", "final_report", "chat"],
    quality: 91,
    speed: 70,
    costEfficiency: 92,
  },
  {
    id: "deepseek:deepseek-v4-flash",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    description: "低成本快速代码与分析任务",
    capabilities: [
      "text",
      "stream",
      "tool_call",
      "reasoning",
      "coding",
      "long_context",
      "fast",
      "structured_output",
    ],
    recommendedTasks: [
      "chat",
      "read_only",
      "cli",
      "memory",
      "worker",
      "final_answer",
    ],
    quality: 85,
    speed: 91,
    costEfficiency: 96,
  },
  {
    id: "glm:glm-4.7",
    provider: "glm",
    model: "glm-4.7",
    name: "GLM 4.7",
    description: "中文代码、推理和长上下文任务",
    capabilities: TEXT_AGENT_CAPABILITIES,
    recommendedTasks: ALL_TEXT_TASKS,
    quality: 87,
    speed: 76,
    costEfficiency: 86,
  },
  {
    id: "glm:glm-4.6v",
    provider: "glm",
    model: "glm-4.6v",
    name: "GLM 4.6V",
    description: "视觉编程、截图理解和图文任务",
    capabilities: [
      "text",
      "vision",
      "stream",
      "tool_call",
      "reasoning",
      "coding",
      "long_context",
    ],
    recommendedTasks: ["chat", "read_only", "worker", "reviewer"],
    quality: 87,
    speed: 68,
    costEfficiency: 78,
  },
  {
    id: "kimi:kimi-k2.5",
    provider: "kimi",
    model: "kimi-k3",
    name: "Kimi K3",
    description: "长上下文、多模态和复杂任务",
    capabilities: [
      "text",
      "vision",
      "stream",
      "tool_call",
      "reasoning",
      "coding",
      "long_context",
      "structured_output",
    ],
    recommendedTasks: ALL_TEXT_TASKS,
    quality: 89,
    speed: 74,
    costEfficiency: 84,
  },
];

export function getModelDefinition(
  modelIdOrVendorModel: string | undefined,
): LlmModelDefinition | undefined {
  const value = modelIdOrVendorModel?.trim();
  if (!value || value === AUTO_MODEL_ID) return undefined;
  return LLM_MODEL_CATALOG.find(
    (item) => item.id === value || item.model === value,
  );
}

export function getModelsForProvider(
  provider: LlmProviderId,
): readonly LlmModelDefinition[] {
  return LLM_MODEL_CATALOG.filter((item) => item.provider === provider);
}

export function isKnownModelId(value: string): boolean {
  return value === AUTO_MODEL_ID || Boolean(getModelDefinition(value));
}
