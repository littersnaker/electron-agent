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

/** 聊天选择器只展示可通过 LLM Gateway 调用的模型。 */
export const AVAILABLE_MODELS: readonly ModelOption[] = [
  {
    id: AUTO_MODEL_ID,
    name: "Auto Orchestration",
    provider: "自动编排",
    description: "按任务能力选择聊天模型；图片输入时仅使用 vision 模型",
  },
  ...LLM_MODEL_CATALOG.filter(
    (model) => model.chatCompatible !== false,
  ).map((model) => ({
    id: model.id,
    name: model.name,
    provider: getProviderDefinition(model.provider).name,
    description: model.description,
  })),
];
