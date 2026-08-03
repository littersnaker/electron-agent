// 模块说明：前端媒体模型注册表直接读取 config/media-models.json。
import type { MediaMode } from "@/app/constants/page-constants";
import type { MediaModelDefinition } from "./types";
import mediaModelConfig from "../../../config/media-models.json";

export const DEFAULT_MEDIA_MODEL_ID = mediaModelConfig.defaultMediaModelId;

/**
 * 媒体模型注册表（唯一源文件：config/media-models.json）。
 * 图片模型和视频模型的接口协议不同，因此不放进普通 LLM Gateway。
 */
export const MEDIA_MODEL_CATALOG: readonly MediaModelDefinition[] =
  mediaModelConfig.models as unknown as readonly MediaModelDefinition[];

export function getMediaModelDefinition(
  modelId: string,
): MediaModelDefinition | undefined {
  return MEDIA_MODEL_CATALOG.find((model) => model.id === modelId);
}

export function getMediaModelsByMode(
  mode: MediaMode,
): readonly MediaModelDefinition[] {
  return MEDIA_MODEL_CATALOG.filter((model) => model.modes.includes(mode));
}
