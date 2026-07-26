"use client";
/**
 * 模块职责：聊天输入器类型、模式配置和展示文案。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { ChangeEvent, RefObject } from "react";
import type { AttachedFile, ComposerMode, ImageEditFidelity, MediaMode, SessionMode, TypographyPolicy } from "../../constants/page-constants";
import type { ModelOption } from "../../constants/modelList";
import type { CommerceMarketplaceCode } from "../../lib/commerce/types";
export interface ChatComposerProps {
  mode?: SessionMode;
  commerceMarketplace?: CommerceMarketplaceCode;
  onCommerceMarketplaceChange?: (marketplace: CommerceMarketplaceCode) => void;
  commerceDataSourceState?: "environment" | "local" | "none";
  onOpenServiceSettings?: () => void;
  composerMode: ComposerMode;
  onComposerModeChange: (mode: ComposerMode) => void;
  typographyPolicy: TypographyPolicy;
  onTypographyPolicyChange: (policy: TypographyPolicy) => void;
  imageEditFidelity: ImageEditFidelity;
  onImageEditFidelityChange: (fidelity: ImageEditFidelity) => void;
  enableQualityGuard: boolean;
  onEnableQualityGuardChange: (enabled: boolean) => void;
  input: string;
  onInputChange: (value: string) => void;
  attachedFile: AttachedFile | null;
  onRemoveFile: () => void;
  isParsingFile: boolean;
  isStreaming: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileSelect: (event: ChangeEvent<HTMLInputElement>) => void;
  models: readonly ModelOption[];
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  onSubmit: () => void;
}

export const TYPOGRAPHY_OPTIONS: ReadonlyArray<{
  value: TypographyPolicy;
  label: string;
  description: string;
}> = [
  {
    value: "avoid-generated-text",
    label: "无字底图（推荐）",
    description: "禁止模型生成文字，预留后期排版区域。",
  },
  {
    value: "strict-short-text",
    label: "严格短文案",
    description: "只允许模型绘制明确提供的短文字。",
  },
  {
    value: "model-default",
    label: "模型默认",
    description: "不附加文字限制，可能出现歪字或乱码。",
  },
];

export const IMAGE_EDIT_FIDELITY_OPTIONS: ReadonlyArray<{
  value: ImageEditFidelity;
  label: string;
  description: string;
}> = [
  {
    value: "precise",
    label: "精准修改（推荐）",
    description: "关闭提示词扩写，只改目标区域，适合 UI、商品图和文字替换。",
  },
  {
    value: "balanced",
    label: "平衡编辑",
    description: "保留主体与布局，允许目标附近做必要的局部重绘。",
  },
  {
    value: "creative",
    label: "创意重构",
    description: "允许明显重绘，适合风格迁移和重新设计。",
  },
];

export const MODE_TABS: ReadonlyArray<{
  value: ComposerMode;
  label: string;
  description: string;
}> = [
  { value: "chat", label: "问答", description: "文字问答与图片理解" },
  { value: "text-to-image", label: "生图", description: "文字生成图片" },
  { value: "image-edit", label: "改图", description: "上传图片后按指令编辑" },
  { value: "text-to-video", label: "文生视频", description: "文字生成视频" },
  { value: "image-to-video", label: "图生视频", description: "首帧图片生成视频" },
  {
    value: "reference-to-video",
    label: "参考生视频",
    description: "参考主体图片生成视频",
  },
  { value: "video-edit", label: "视频编辑", description: "上传视频后进行编辑" },
];

export function requiresAttachment(mode: MediaMode): boolean {
  return [
    "image-edit",
    "image-to-video",
    "reference-to-video",
    "video-edit",
  ].includes(mode);
}

export function resolveAccept(composerMode: ComposerMode): string {
  switch (composerMode) {
    case "image-edit":
    case "image-to-video":
    case "reference-to-video":
      return "image/*";
    case "video-edit":
      return "video/*";
    case "text-to-image":
      return "image/*";
    case "text-to-video":
      return "image/*,video/*";
    default:
      return "image/*,application/pdf,text/*";
  }
}

export function resolvePlaceholder(
  sessionMode: SessionMode | undefined,
  composerMode: ComposerMode,
): string {
  if (sessionMode === "code") {
    return "描述要分析、创建或修改的项目任务…";
  }
  if (sessionMode === "commerce") {
    return "描述一个市场方向，例如：美国宠物饮水机市场有哪些品牌、价格带和机会信号？";
  }

  switch (composerMode) {
    case "text-to-image":
      return "描述要生成的图片，例如：极简电商主图，浅灰背景，产品居中，柔和科技感打光…";
    case "image-edit":
      return "上传图片并描述修改要求，例如：保留产品不变，把背景改为浅灰摄影棚并增强金属质感…";
    case "text-to-video":
      return "描述要生成的视频镜头、动作和风格…";
    case "image-to-video":
      return "上传一张首帧图片，再描述镜头运动和主体动作…";
    case "reference-to-video":
      return "上传参考图片，再描述主体在视频中的场景和动作…";
    case "video-edit":
      return "上传视频并描述风格转换、元素替换或局部编辑要求…";
    default:
      return "输入你的问题…";
  }
}

export function resolveSubmitLabel(
  sessionMode: SessionMode | undefined,
  composerMode: ComposerMode,
): string {
  if (sessionMode === "commerce") return "开始研究";
  return composerMode === "chat" ? "发送" : "开始生成";
}
