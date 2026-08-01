// 模块说明：集中维护模型选择器展示项；内置聊天模型只供 Auto 使用，不再直接展示。
import type { MediaMode } from "./page-constants";
import { AUTO_MODEL_ID } from "../lib/llm/registry/models";
import type { CustomModelRecord } from "../lib/llm/custom-models";
import { getProviderDefinition } from "../lib/llm/registry/providers";
import { getMediaModelsByMode } from "../lib/media/catalog";

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  description: string;
  isCustom?: boolean;
  customModel?: CustomModelRecord;
}

/** 普通问答只固定展示 Auto；用户新增模型会在运行时追加。 */
export const AVAILABLE_CHAT_MODELS: readonly ModelOption[] = [
  {
    id: AUTO_MODEL_ID,
    name: "Auto Orchestration",
    provider: "自动编排",
    description: "自动探测内部候选和用户自定义模型，使用第一个可用结果",
  },
];

/** 把 SQLite 自定义模型转换成选择器展示项。 */
export function getCustomModelOptions(
  models: readonly CustomModelRecord[],
): readonly ModelOption[] {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    provider: getProviderDefinition(model.provider).name,
    description: `${model.model}${model.baseUrl ? ` · ${model.baseUrl}` : ""}`,
    isCustom: true,
    customModel: model,
  }));
}

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
