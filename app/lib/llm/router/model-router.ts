import {
  AUTO_MODEL_ID,
  LLM_MODEL_CATALOG,
  getModelDefinition,
} from "../registry/models";
import {
  getMissingCapabilities,
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

function assertChatCompatible(model: LlmModelDefinition): void {
  if (model.chatCompatible === false) {
    throw new Error(
      `模型 ${model.name} 使用独立的媒体生成接口，不能通过聊天接口调用。请在聊天中选择 Qwen VL、Gemini、GPT 或其他视觉理解模型。`,
    );
  }
}

/** 根据任务、凭证和能力返回模型路由及降级顺序。 */
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

    assertChatCompatible(model);

    if (
      !modelSupportsCapabilities(model.capabilities, requiredCapabilities)
    ) {
      const missing = getMissingCapabilities(
        model.capabilities,
        requiredCapabilities,
      );
      const message = missing.includes("vision")
        ? "当前请求包含图片，但所选模型不支持图片理解。请选择带 vision 能力的聊天模型，或改用 Auto。"
        : `模型不满足任务能力要求: ${explainRequired(missing)}`;
      throw new Error(`模型 ${model.name} 不可用于本次请求：${message}`);
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

  const environmentModelId = process.env[TASK_ENV_KEYS[input.task]]?.trim();
  const candidates = LLM_MODEL_CATALOG.flatMap((model) => {
    if (model.chatCompatible === false) return [];

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
    const visionHint = requiredCapabilities.includes("vision")
      ? "本次请求包含图片，必须配置至少一个支持图片理解且可走聊天接口的 vision 模型。"
      : "请配置至少一个具有对应能力的聊天模型。";

    throw new Error(
      [
        `没有可用模型满足能力要求: ${explainRequired(requiredCapabilities)}`,
        `已配置 Provider: ${configuredProviders || "无"}`,
        visionHint,
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
          ? "Auto Router 从可用聊天模型池中选择最高评分模型"
          : `Auto Router 降级候选 ${fallbackIndex}`,
      fallbackIndex,
    }),
  );

  return { requestedModelId, requiredCapabilities, routes };
}

export function resolveModelRoute(
  input: Parameters<typeof resolveModelRoutes>[0],
): LlmModelRoute {
  const result = resolveModelRoutes(input);
  const route = result.routes[0];
  if (!route) throw new Error("Model Router 未生成可用路由");
  return route;
}
