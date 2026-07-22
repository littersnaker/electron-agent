import type {
  LlmModelDefinition,
  LlmProviderId,
  LlmTaskType,
} from "./types";

export const AUTO_MODEL_ID = "auto";
export const DEFAULT_MODEL_ID = "qwen:qwen3.7-max-2026-05-20";

const ALL_AGENT_TASKS: readonly LlmTaskType[] = [
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

/**
 * 模型目录只保存稳定元数据，不保存 API Key。
 * 新增模型时只需要在这里登记，不需要修改 Agent 业务代码。
 */
export const LLM_MODEL_CATALOG: readonly LlmModelDefinition[] = [
  {
    id: DEFAULT_MODEL_ID,
    provider: "qwen",
    model: "qwen3.7-max",
    name: "Qwen 3.7 Max",
    description: "默认代码与复杂任务模型",
    supportsTools: true,
    recommendedTasks: ALL_AGENT_TASKS,
  },
  {
    id: "qwen:qwen3.7-plus",
    provider: "qwen",
    model: "qwen3.7-plus-2026-05-26",
    name: "Qwen 3.7 Plus",
    description: "适合快速问答、摘要和低成本任务",
    supportsTools: true,
    recommendedTasks: ["chat", "read_only", "cli", "memory"],
  },
  {
    id: "openai:gpt-5.1",
    provider: "openai",
    model: "gpt-5.1",
    name: "OpenAI GPT-5.1",
    description: "适合规划、审查和复杂推理",
    supportsTools: true,
    recommendedTasks: [
      "chat",
      "planner",
      "worker",
      "reviewer",
      "final_report",
      "final_answer",
    ],
  },
  {
    id: "gemini:gemini-3.5-flash",
    provider: "gemini",
    model: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    description: "适合快速只读分析、摘要和交互回答",
    supportsTools: true,
    recommendedTasks: ["chat", "read_only", "cli", "memory", "final_answer"],
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
