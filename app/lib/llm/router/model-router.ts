import {
  AUTO_MODEL_ID,
  LLM_MODEL_CATALOG,
  getModelDefinition,
} from "../registry/models";
import {
  getTaskCapabilities,
  mergeCapabilities,
  modelSupportsCapabilities,
} from "./capabilities";
import { scoreModel } from "./scorer";
import type {
  LlmCapability,
  LlmCredentials,
  LlmModelDefinition,
  LlmModelRoute,
  LlmProviderId,
  LlmRoutingResult,
  LlmTaskType,
} from "../types";

const TASK_ENV_KEYS: Record<LlmTaskType, string> = {
  chat: "LLM_ROUTE_CHAT",
  read_only: "LLM_ROUTE_READ_ONLY",
  cli: "LLM_ROUTE_CLI",
  memory: "LLM_ROUTE_MEMORY",
  planner: "LLM_ROUTE_PLANNER",
  worker: "LLM_ROUTE_WORKER",
  reviewer: "LLM_ROUTE_REVIEWER",
  final_report: "LLM_ROUTE_FINAL_REPORT",
  final_answer: "LLM_ROUTE_FINAL_ANSWER",
};

function getCredential(
  credentials: LlmCredentials,
  provider: LlmProviderId,
): string | undefined {
  const value = credentials[provider]?.trim();
  return value || undefined;
}

function buildRoute(input: {
  task: LlmTaskType;
  requestedModelId: string;
  model: LlmModelDefinition;
  apiKey: string;
  score: number;
  reason: string;
  fallbackIndex: number;
}): LlmModelRoute {
  return {
    task: input.task,
    requestedModelId: input.requestedModelId,
    modelId: input.model.id,
    provider: input.model.provider,
    model: input.model.model,
    apiKey: input.apiKey,
    reason: input.reason,
    score: input.score,
    fallbackIndex: input.fallbackIndex,
    capabilities: input.model.capabilities,
  };
}

function explainRequired(
  capabilities: readonly LlmCapability[],
): string {
  return capabilities.join("、") || "text";
}

/**
 * 返回按优先级排列的模型路由，而不是单个固定模型。
 *
 * Auto 模式：
 * 1. 先排除没有凭证的 Provider；
 * 2. 再排除能力不足的模型；
 * 3. 对剩余候选评分；
 * 4. 返回完整 Fallback 列表。
 *
 * 用户明确指定模型时仍保持严格模式，避免界面选择与实际模型不一致。
 */
export function resolveModelRoutes(input: {
  task: LlmTaskType;
  preferredModelId?: string;
  credentials: LlmCredentials;
  requiredCapabilities?: readonly LlmCapability[];
}): LlmRoutingResult {
  const requestedModelId = input.preferredModelId?.trim() || AUTO_MODEL_ID;
  const requiredCapabilities = mergeCapabilities(
    getTaskCapabilities(input.task),
    input.requiredCapabilities,
  );

  if (requestedModelId !== AUTO_MODEL_ID) {
    const model = getModelDefinition(requestedModelId);
    if (!model) throw new Error(`未知模型配置: ${requestedModelId}`);
    if (
      !modelSupportsCapabilities(model.capabilities, requiredCapabilities)
    ) {
      throw new Error(
        `模型 ${model.name} 不满足任务能力要求: ${explainRequired(
          requiredCapabilities,
        )}`,
      );
    }
    const apiKey = getCredential(input.credentials, model.provider);
    if (!apiKey) {
      throw new Error(
        `模型 ${model.name} 缺少 ${model.provider.toUpperCase()} API Key`,
      );
    }
    return {
      requestedModelId,
      requiredCapabilities,
      routes: [
        buildRoute({
          task: input.task,
          requestedModelId,
          model,
          apiKey,
          score: 100,
          reason: "使用界面明确指定模型",
          fallbackIndex: 0,
        }),
      ],
    };
  }

  const environmentModelId =
    process.env[TASK_ENV_KEYS[input.task]]?.trim();
  const candidates = LLM_MODEL_CATALOG.flatMap((model) => {
    const apiKey = getCredential(input.credentials, model.provider);
    if (!apiKey) return [];
    if (
      !modelSupportsCapabilities(model.capabilities, requiredCapabilities)
    ) {
      return [];
    }
    const score = scoreModel({
      model,
      task: input.task,
      requiredCapabilities,
      environmentModelId,
    });
    return [{ model, apiKey, score }];
  }).sort((left, right) => right.score - left.score);

  if (!candidates.length) {
    const configuredProviders = Object.entries(input.credentials)
      .filter(([, value]) => Boolean(value?.trim()))
      .map(([provider]) => provider)
      .join("、");
    throw new Error(
      [
        `没有可用模型满足能力要求: ${explainRequired(
          requiredCapabilities,
        )}`,
        `已配置 Provider: ${configuredProviders || "无"}`,
        "请配置至少一个具有对应能力的模型服务。",
      ].join("；"),
    );
  }

  const routes = candidates.map((candidate, fallbackIndex) =>
    buildRoute({
      task: input.task,
      requestedModelId,
      model: candidate.model,
      apiKey: candidate.apiKey,
      score: candidate.score,
      reason:
        fallbackIndex === 0
          ? `Auto Router 从可用模型池中选择最高评分模型`
          : `Auto Router 降级候选 ${fallbackIndex}`,
      fallbackIndex,
    }),
  );

  return { requestedModelId, requiredCapabilities, routes };
}

/** 兼容 V6 只需要单条路由的调用方。 */
export function resolveModelRoute(
  input: Parameters<typeof resolveModelRoutes>[0],
): LlmModelRoute {
  const result = resolveModelRoutes(input);
  const route = result.routes[0];
  if (!route) throw new Error("Model Router 未生成可用路由");
  return route;
}
