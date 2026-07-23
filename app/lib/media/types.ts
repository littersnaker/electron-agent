import type {
  ImageEditFidelity,
  MediaMode,
  MessageAttachment,
  TypographyPolicy,
} from "@/app/const/pageConst";
import type { LlmCredentials } from "@/app/lib/llm/types";
import type { TokenInfo } from "@/app/types/workspace";

export interface MediaModelDefinition {
  id: string;
  provider: "qwen";
  model: string;
  name: string;
  description: string;
  modes: readonly MediaMode[];
  outputKind: "image" | "video";
  protocol: "qwen-image-sync" | "dashscope-video-async";
}

export interface MediaAttachmentInput {
  name: string;
  mimeType: string;
  data: string;
  dataUrl?: string;
}

export interface MediaGenerateRequest {
  credentials: LlmCredentials;
  modelId: string;
  mode: MediaMode;
  prompt: string;
  typographyPolicy: TypographyPolicy;
  /** 图片编辑时控制“保留原图”和“允许重绘”的程度。 */
  imageEditFidelity: ImageEditFidelity;
  /**
   * 开启后使用视觉模型比较原图与编辑结果。
   * 若发现明显重影、重复元素或无关区域被改动，最多自动重试一次。
   */
  enableQualityGuard: boolean;
  attachment?: MediaAttachmentInput;
  size?: string;
  /** 浏览器停止生成或客户端断开时，向百炼请求传播取消信号。 */
  signal?: AbortSignal;
}

export interface MediaQualityReport {
  checked: boolean;
  passed: boolean;
  retried: boolean;
  ghostingDetected: boolean;
  unrelatedChangesDetected: boolean;
  reason?: string;
}

export interface MediaGenerateResult {
  content: string;
  attachments: MessageAttachment[];
  /** 图片/视频一般没有传统 token，统一返回生成份数作为媒体额度。 */
  usage: TokenInfo;
  quality?: MediaQualityReport;
}
