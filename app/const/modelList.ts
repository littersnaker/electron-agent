import type { MediaMode } from "./pageConst";
import {
  AUTO_MODEL_ID,
  LLM_MODEL_CATALOG,
} from "../lib/llm/registry/models";
import { getProviderDefinition } from "../lib/llm/registry/providers";
import { getMediaModelsByMode } from "../lib/media/catalog";

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  description: string;
}

/** 普通问答 / Code Agent 使用的聊天模型。 */
export const AVAILABLE_CHAT_MODELS: readonly ModelOption[] = [
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

/** 绘图 / 视频模式根据能力只显示可调用的媒体模型。 */
export function getAvailableMediaModelOptions(
  mode: MediaMode,
): readonly ModelOption[] {
  return getMediaModelsByMode(mode).map((model) => ({
    id: model.id,
    name: model.name,
    provider: "Qwen / DashScope",
    description: model.description,
  }));
}

/** 保留旧导出，避免现有聊天代码产生无意义改动。 */
export const AVAILABLE_MODELS = AVAILABLE_CHAT_MODELS;
