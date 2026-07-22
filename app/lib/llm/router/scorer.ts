import type {
  LlmCapability,
  LlmModelDefinition,
  LlmTaskType,
} from "../types";

const TASK_WEIGHTS: Record<
  LlmTaskType,
  { quality: number; speed: number; cost: number }
> = {
  chat: { quality: 0.3, speed: 0.45, cost: 0.25 },
  read_only: { quality: 0.4, speed: 0.3, cost: 0.3 },
  cli: { quality: 0.25, speed: 0.5, cost: 0.25 },
  memory: { quality: 0.4, speed: 0.25, cost: 0.35 },
  planner: { quality: 0.65, speed: 0.15, cost: 0.2 },
  worker: { quality: 0.55, speed: 0.2, cost: 0.25 },
  reviewer: { quality: 0.7, speed: 0.1, cost: 0.2 },
  final_report: { quality: 0.6, speed: 0.15, cost: 0.25 },
  final_answer: { quality: 0.4, speed: 0.4, cost: 0.2 },
};

const CAPABILITY_BONUS: Partial<Record<LlmCapability, number>> = {
  reasoning: 4,
  coding: 4,
  vision: 5,
  tool_call: 3,
  long_context: 2,
  fast: 2,
  structured_output: 2,
};

/** 给满足硬性能力过滤后的模型计算软性排序分数。 */
export function scoreModel(input: {
  model: LlmModelDefinition;
  task: LlmTaskType;
  requiredCapabilities: readonly LlmCapability[];
  preferredModelId?: string;
  environmentModelId?: string;
}): number {
  const { model, task } = input;
  const weights = TASK_WEIGHTS[task];
  let score =
    model.quality * weights.quality +
    model.speed * weights.speed +
    model.costEfficiency * weights.cost;

  if (model.recommendedTasks.includes(task)) score += 8;
  if (model.id === input.preferredModelId) score += 18;
  if (model.id === input.environmentModelId) score += 24;

  for (const capability of input.requiredCapabilities) {
    score += CAPABILITY_BONUS[capability] ?? 1;
  }

  return Number(score.toFixed(2));
}
