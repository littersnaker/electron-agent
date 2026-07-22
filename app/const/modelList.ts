import {
  AUTO_MODEL_ID,
  LLM_MODEL_CATALOG,
} from "../lib/llm/model-catalog";

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  description: string;
}

/** 前端只消费公开模型元数据，不包含任何服务端凭证。 */
export const AVAILABLE_MODELS: readonly ModelOption[] = [
  // {
  //   id: AUTO_MODEL_ID,
  //   name: "Auto Router",
  //   provider: "自动路由",
  //   description: "根据 Planner、Worker、Review 等任务类型选择可用模型",
  // },
  ...LLM_MODEL_CATALOG.map((model) => ({
    id: model.id,
    name: model.name,
    provider:
      model.provider === "qwen"
        ? "Qwen"
        : model.provider === "openai"
          ? "OpenAI"
          : "Gemini",
    description: model.description,
  })),
];
