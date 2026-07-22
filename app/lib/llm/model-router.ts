import {
  AUTO_MODEL_ID,
  DEFAULT_MODEL_ID,
  LLM_MODEL_CATALOG,
  getModelDefinition,
} from "./model-catalog";
import type {
  LlmCredentials,
  LlmModelDefinition,
  LlmModelRoute,
  LlmProviderId,
  LlmTaskType,
} from "./types";

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

const AUTO_CANDIDATES: Record<LlmTaskType, readonly string[]> = {
  chat: ["gemini:gemini-3.5-flash", "qwen:qwen3.7-max", "openai:gpt-5.1"],
  read_only: ["gemini:gemini-3.5-flash", "qwen:qwen3.7-max", "openai:gpt-5.1"],
  cli: ["qwen:qwen3.7-max", "gemini:gemini-3.5-flash", "openai:gpt-5.1"],
  memory: ["qwen:qwen3.7-max", "gemini:gemini-3.5-flash", "openai:gpt-5.1"],
  planner: ["openai:gpt-5.1", DEFAULT_MODEL_ID, "gemini:gemini-3.5-flash"],
  worker: [DEFAULT_MODEL_ID, "openai:gpt-5.1", "gemini:gemini-3.5-flash"],
  reviewer: ["openai:gpt-5.1", DEFAULT_MODEL_ID, "gemini:gemini-3.5-flash"],
  final_report: ["openai:gpt-5.1", DEFAULT_MODEL_ID, "gemini:gemini-3.5-flash"],
  final_answer: ["gemini:gemini-3.5-flash", DEFAULT_MODEL_ID, "openai:gpt-5.1"],
};

function getCredential(
  credentials: LlmCredentials,
  provider: LlmProviderId,
): string | undefined {
  const value = credentials[provider]?.trim();
  return value || undefined;
}

function createRoute(
  task: LlmTaskType,
  requestedModelId: string,
  model: LlmModelDefinition,
  apiKey: string,
  reason: string,
): LlmModelRoute {
  return {
    task,
    requestedModelId,
    modelId: model.id,
    provider: model.provider,
    model: model.model,
    apiKey,
    reason,
  };
}

function requireModelCredential(
  task: LlmTaskType,
  requestedModelId: string,
  model: LlmModelDefinition,
  credentials: LlmCredentials,
  reason: string,
): LlmModelRoute {
  const apiKey = getCredential(credentials, model.provider);
  if (!apiKey) {
    throw new Error(
      `模型 ${model.name} 缺少 ${model.provider.toUpperCase()} API Key`,
    );
  }
  return createRoute(task, requestedModelId, model, apiKey, reason);
}

/**
 * 根据任务类型、用户选择和可用凭证选择模型。
 *
 * 优先级：环境变量任务路由 > 用户指定模型 > Auto 候选列表。
 * 指定模型缺少 Key 时直接报错，防止悄悄切换模型造成结果不可预测。
 */
export function resolveModelRoute(input: {
  task: LlmTaskType;
  preferredModelId?: string;
  credentials: LlmCredentials;
}): LlmModelRoute {
  const requestedModelId = input.preferredModelId?.trim() || AUTO_MODEL_ID;
  const envModelId = process.env[TASK_ENV_KEYS[input.task]]?.trim();

  if (envModelId) {
    const envModel = getModelDefinition(envModelId);
    if (!envModel) {
      throw new Error(
        `${TASK_ENV_KEYS[input.task]} 配置了未知模型: ${envModelId}`,
      );
    }
    return requireModelCredential(
      input.task,
      requestedModelId,
      envModel,
      input.credentials,
      `命中任务环境变量 ${TASK_ENV_KEYS[input.task]}`,
    );
  }

  if (requestedModelId !== AUTO_MODEL_ID) {
    const requestedModel = getModelDefinition(requestedModelId);
    if (!requestedModel) {
      throw new Error(`未知模型配置: ${requestedModelId}`);
    }
    return requireModelCredential(
      input.task,
      requestedModelId,
      requestedModel,
      input.credentials,
      "使用界面指定模型",
    );
  }

  for (const candidateId of AUTO_CANDIDATES[input.task]) {
    const candidate = getModelDefinition(candidateId);
    if (!candidate) continue;
    const apiKey = getCredential(input.credentials, candidate.provider);
    if (apiKey) {
      return createRoute(
        input.task,
        requestedModelId,
        candidate,
        apiKey,
        `Auto Router 为 ${input.task} 选择首个可用模型`,
      );
    }
  }

  const availableProviders = LLM_MODEL_CATALOG.map((item) => item.provider)
    .filter((provider, index, list) => list.indexOf(provider) === index)
    .join("、");
  throw new Error(`没有可用模型凭证，请配置 ${availableProviders} API Key`);
}
