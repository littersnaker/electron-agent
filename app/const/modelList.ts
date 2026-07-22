import {
  AUTO_MODEL_ID,
  LLM_MODEL_CATALOG,
} from "../lib/llm/registry/models";
import { getProviderDefinition } from "../lib/llm/registry/providers";

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  description: string;
}

/** 前端模型列表直接由 V7 注册表生成。 */
export const AVAILABLE_MODELS: readonly ModelOption[] = [
  {
    id: AUTO_MODEL_ID,
    name: "Auto Orchestration",
    provider: "自动编排",
    description: "仅从已配置模型池中按能力评分，并在调用失败时自动降级",
  },
  ...LLM_MODEL_CATALOG.map((model) => ({
    id: model.id,
    name: model.name,
    provider: getProviderDefinition(model.provider).name,
    description: model.description,
  })),
];
