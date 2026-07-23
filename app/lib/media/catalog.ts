import type { MediaMode } from "@/app/const/pageConst";
import type { MediaModelDefinition } from "./types";

export const DEFAULT_MEDIA_MODEL_ID = "qwen:qwen-image-2.0-pro";

/**
 * 百炼媒体模型注册表。
 *
 * 图片模型和视频模型的接口协议不同，因此不放进普通 LLM Gateway。
 * UI 只读取本注册表，避免在组件内写死模型 ID。
 */
export const MEDIA_MODEL_CATALOG: readonly MediaModelDefinition[] = [
  {
    id: DEFAULT_MEDIA_MODEL_ID,
    provider: "qwen",
    model: "qwen-image-2.0-pro-2026-06-22",
    name: "Qwen-Image 2.0 Pro",
    description: "千问图像生成与编辑 Pro，文字渲染、真实质感和指令遵循更强。",
    modes: ["text-to-image", "image-edit"],
    outputKind: "image",
    protocol: "qwen-image-sync",
  },
  {
    id: "qwen:qwen-image-2.0",
    provider: "qwen",
    model: "qwen-image-2.0",
    name: "Qwen-Image 2.0",
    description: "速度更快的千问图像生成与编辑模型。",
    modes: ["text-to-image", "image-edit"],
    outputKind: "image",
    protocol: "qwen-image-sync",
  },
  {
    id: "qwen:wan2.7-t2v-2026-06-12",
    provider: "qwen",
    model: "wan2.7-t2v-2026-06-12",
    name: "Wan 2.7 文生视频 2026-06-12",
    description: "截图中的 Wan 2.7 文生视频模型。",
    modes: ["text-to-video"],
    outputKind: "video",
    protocol: "dashscope-video-async",
  },
  {
    id: "qwen:wan2.7-t2v-2026-04-25",
    provider: "qwen",
    model: "wan2.7-t2v-2026-04-25",
    name: "Wan 2.7 文生视频 2026-04-25",
    description: "截图中的 Wan 2.7 文生视频快照模型。",
    modes: ["text-to-video"],
    outputKind: "video",
    protocol: "dashscope-video-async",
  },
  {
    id: "qwen:happyhorse-1.1-t2v",
    provider: "qwen",
    model: "happyhorse-1.1-t2v",
    name: "HappyHorse 1.1 文生视频",
    description: "截图中的 HappyHorse 有声文生视频模型。",
    modes: ["text-to-video"],
    outputKind: "video",
    protocol: "dashscope-video-async",
  },
  {
    id: "qwen:wan2.7-i2v-2026-04-25",
    provider: "qwen",
    model: "wan2.7-i2v-2026-04-25",
    name: "Wan 2.7 图生视频",
    description: "截图中的首帧/首尾帧图生视频模型。",
    modes: ["image-to-video"],
    outputKind: "video",
    protocol: "dashscope-video-async",
  },
  {
    id: "qwen:happyhorse-1.1-r2v",
    provider: "qwen",
    model: "happyhorse-1.1-r2v",
    name: "HappyHorse 1.1 参考生视频",
    description: "截图中的多参考图生视频模型。",
    modes: ["reference-to-video"],
    outputKind: "video",
    protocol: "dashscope-video-async",
  },
  {
    id: "qwen:wan2.7-r2v-2026-06-12",
    provider: "qwen",
    model: "wan2.7-r2v-2026-06-12",
    name: "Wan 2.7 参考生视频",
    description: "截图中的 Wan 2.7 多模态参考生视频模型。",
    modes: ["reference-to-video"],
    outputKind: "video",
    protocol: "dashscope-video-async",
  },
  {
    id: "qwen:happyhorse-1.0-video-edit",
    provider: "qwen",
    model: "happyhorse-1.0-video-edit",
    name: "HappyHorse 1.0 视频编辑",
    description: "截图中的视频风格转换、元素替换与局部编辑模型。",
    modes: ["video-edit"],
    outputKind: "video",
    protocol: "dashscope-video-async",
  },
] as const;

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
