/**
 * 模块职责：DashScope 基础配置、图片生成与图片下载。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { Buffer } from "node:buffer";
import type { MessageAttachment } from "@/app/constants/page-constants";
import { getMediaModelDefinition } from "../catalog";
import { buildImageEditPolicy } from "../edit-policy";
import { assessImageEditQuality } from "../edit-quality";
import { buildMediaPrompt } from "../prompt";
import type { MediaAttachmentInput, MediaGenerateRequest, MediaGenerateResult } from "../types";
export const DEFAULT_DASHSCOPE_API_BASE = "https://dashscope.aliyuncs.com";

export const IMAGE_ENDPOINT_PATH =
  "/api/v1/services/aigc/multimodal-generation/generation";

export const VIDEO_ENDPOINT_PATH =
  "/api/v1/services/aigc/video-generation/video-synthesis";

export interface DashScopeErrorPayload {
  code?: string;
  message?: string;
  request_id?: string;
}

export interface UploadPolicyPayload extends DashScopeErrorPayload {
  data?: {
    policy?: string;
    signature?: string;
    upload_dir?: string;
    upload_host?: string;
    max_file_size_mb?: string | number;
    oss_access_key_id?: string;
    x_oss_object_acl?: string;
    x_oss_forbid_overwrite?: string;
  };
}

export function getApiBase(): string {
  return (
    process.env.DASHSCOPE_API_BASE?.trim().replace(/\/$/u, "") ||
    DEFAULT_DASHSCOPE_API_BASE
  );
}

/**
 * 临时文件上传接口默认使用 DashScope 公共域名。
 * 如果账号使用其他地域，可单独设置 DASHSCOPE_UPLOAD_API_BASE。
 */
export function getUploadApiBase(): string {
  return (
    process.env.DASHSCOPE_UPLOAD_API_BASE?.trim().replace(/\/$/u, "") ||
    DEFAULT_DASHSCOPE_API_BASE
  );
}

export function getQwenApiKey(request: MediaGenerateRequest): string {
  const apiKey = request.credentials.qwen?.trim();
  if (!apiKey) {
    throw new Error("未配置百炼 API Key，无法调用图片/视频模型。");
  }
  return apiKey;
}

export function toDataUrl(attachment: MediaAttachmentInput): string {
  if (attachment.dataUrl?.startsWith("data:")) return attachment.dataUrl;
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

export async function readJsonResponse<T>(response: Response): Promise<T> {
  const payload = (await response.json()) as T & DashScopeErrorPayload;
  if (!response.ok) {
    throw new Error(
      payload.message ||
        payload.code ||
        `百炼请求失败（HTTP ${response.status}）`,
    );
  }
  return payload;
}

export function extractImageUrls(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const root = payload as Record<string, unknown>;
  const output = root.output;
  if (!output || typeof output !== "object") return [];
  const choices = (output as Record<string, unknown>).choices;
  if (!Array.isArray(choices)) return [];

  return choices.flatMap((choice) => {
    if (!choice || typeof choice !== "object") return [];
    const message = (choice as Record<string, unknown>).message;
    if (!message || typeof message !== "object") return [];
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) return [];

    return content.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const image = (item as Record<string, unknown>).image;
      return typeof image === "string" && image ? [image] : [];
    });
  });
}

export async function downloadImageAsAttachment(
  url: string,
  index: number,
  signal?: AbortSignal,
): Promise<MessageAttachment> {
  const response = await fetch(url, { cache: "no-store", signal });
  if (!response.ok) {
    throw new Error(`生成成功，但下载结果图片失败（HTTP ${response.status}）。`);
  }

  const mimeType = response.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = mimeType.includes("jpeg") ? "jpg" : "png";
  const fileName = `qwen-image-${Date.now()}-${index + 1}.${extension}`;

  return {
    name: fileName,
    downloadName: fileName,
    type: mimeType,
    assetKind: "image",
    dataUrl: `data:${mimeType};base64,${buffer.toString("base64")}`,
    url,
  };
}

export interface QwenImageResponsePayload extends Record<string, unknown> {
  usage?: {
    image_count?: number;
    width?: number;
    height?: number;
  };
}

export interface QwenImageAttempt {
  attachments: MessageAttachment[];
  imageCount: number;
}

/**
 * 执行单次 Qwen-Image 请求。
 *
 * 精准编辑不启用 prompt_extend，避免模型把“只改标题”扩写成整张图重绘；
 * 同时使用 negative_prompt 明确禁止重影、重复元素和双层边缘。
 */
export async function callQwenImageOnce(
  request: MediaGenerateRequest,
  retryReason?: string,
): Promise<QwenImageAttempt> {
  const model = getMediaModelDefinition(request.modelId);
  if (!model) throw new Error(`未注册的媒体模型：${request.modelId}`);

  const editPolicy =
    request.mode === "image-edit"
      ? buildImageEditPolicy({
          prompt: request.prompt,
          fidelity: request.imageEditFidelity,
          typographyPolicy: request.typographyPolicy,
          retryReason,
        })
      : null;

  const content: Array<Record<string, string>> = [];
  if (request.mode === "image-edit" && request.attachment) {
    content.push({ image: toDataUrl(request.attachment) });
  }
  content.push({
    text:
      editPolicy?.prompt ||
      buildMediaPrompt({
        prompt: request.prompt,
        mode: request.mode,
        typographyPolicy: request.typographyPolicy,
      }),
  });

  const parameters: Record<string, unknown> = {
    n: 1,
    negative_prompt:
      editPolicy?.negativePrompt ||
      "乱码，伪文字，文字扭曲，重复主体，重影，双重曝光，低画质，构图混乱",
    prompt_extend: editPolicy?.promptExtend ?? true,
    watermark: false,
  };

  // 改图时不强制尺寸，官方接口会按输入图比例生成；强制方形会增加重构概率。
  if (request.size) {
    parameters.size = request.size;
  } else if (request.mode === "text-to-image") {
    parameters.size = "2048*2048";
  }

  const response = await fetch(`${getApiBase()}${IMAGE_ENDPOINT_PATH}`, {
    method: "POST",
    signal: request.signal,
    headers: {
      Authorization: `Bearer ${getQwenApiKey(request)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: model.model,
      input: {
        messages: [{ role: "user", content }],
      },
      parameters,
    }),
  });

  const payload = await readJsonResponse<QwenImageResponsePayload>(response);
  const imageUrls = extractImageUrls(payload);
  if (!imageUrls.length) {
    throw new Error("百炼图片任务已完成，但响应中没有图片地址。");
  }

  const attachments = await Promise.all(
    imageUrls.map((url, index) =>
      downloadImageAsAttachment(url, index, request.signal),
    ),
  );

  return {
    attachments,
    imageCount: payload.usage?.image_count || attachments.length,
  };
}

/**
 * 调用千问图片生成/编辑接口，并在精准改图模式下执行质量检查。
 *
 * 质量检查发现明显重影、重复元素或无关区域被修改时，只自动重试一次，
 * 避免无限重试和不可控的额度消耗。重试次数会计入图片额度。
 */
export async function generateQwenImage(
  request: MediaGenerateRequest,
): Promise<MediaGenerateResult> {
  const model = getMediaModelDefinition(request.modelId);
  if (!model) throw new Error(`未注册的媒体模型：${request.modelId}`);

  if (request.mode === "image-edit" && !request.attachment) {
    throw new Error("图片编辑模式必须先上传一张图片。");
  }

  let attempt = await callQwenImageOnce(request);
  let generatedImageCount = attempt.imageCount;
  let qualityChecked = false;
  let qualityPassed = true;
  let retried = false;
  let ghostingDetected = false;
  let unrelatedChangesDetected = false;
  let qualityReason: string | undefined;
  let reviewPromptTokens = 0;
  let reviewCompletionTokens = 0;
  let reviewTotalTokens = 0;

  if (
    request.mode === "image-edit" &&
    request.attachment &&
    request.enableQualityGuard &&
    request.imageEditFidelity !== "creative" &&
    attempt.attachments[0]
  ) {
    const firstReview = await assessImageEditQuality({
      credentials: request.credentials,
      original: request.attachment,
      generated: attempt.attachments[0],
      userPrompt: request.prompt,
      signal: request.signal,
    });

    qualityChecked = firstReview.checked;
    qualityPassed = firstReview.passed;
    ghostingDetected = firstReview.ghostingDetected;
    unrelatedChangesDetected = firstReview.unrelatedChangesDetected;
    qualityReason = firstReview.reason;
    reviewPromptTokens += firstReview.usage.prompt;
    reviewCompletionTokens += firstReview.usage.completion;
    reviewTotalTokens += firstReview.usage.total;

    if (firstReview.checked && !firstReview.passed) {
      retried = true;
      const retryAttempt = await callQwenImageOnce(
        request,
        firstReview.reason || "检测到重影、重复元素或无关区域变化",
      );
      generatedImageCount += retryAttempt.imageCount;
      attempt = retryAttempt;

      const secondReview = await assessImageEditQuality({
        credentials: request.credentials,
        original: request.attachment,
        generated: attempt.attachments[0],
        userPrompt: request.prompt,
        signal: request.signal,
      });

      qualityChecked = qualityChecked || secondReview.checked;
      if (secondReview.checked) {
        qualityPassed = secondReview.passed;
        ghostingDetected = secondReview.ghostingDetected;
        unrelatedChangesDetected = secondReview.unrelatedChangesDetected;
        qualityReason = secondReview.reason;
      } else {
        // 第二次检查不可用时保留首轮失败结论，避免误报“已通过”。
        qualityPassed = false;
        qualityReason = secondReview.reason || firstReview.reason;
      }
      reviewPromptTokens += secondReview.usage.prompt;
      reviewCompletionTokens += secondReview.usage.completion;
      reviewTotalTokens += secondReview.usage.total;
    }
  }

  const qualitySuffix = retried
    ? qualityPassed
      ? "质量检查发现首版存在过度重绘风险，已自动使用更严格的保护规则重试一次。"
      : "已自动重试一次，但视觉检查仍提示可能存在局部重绘，请在下载前确认。"
    : qualityChecked
      ? qualityPassed
        ? "已通过重影与无关改动检查。"
        : "视觉检查提示可能存在局部重绘，请在下载前确认。"
      : "";

  return {
    content:
      request.mode === "image-edit"
        ? `已使用 ${model.name} 完成图片编辑。${qualitySuffix}`
        : `已使用 ${model.name} 完成图片生成。`,
    attachments: attempt.attachments,
    usage: {
      prompt: 0,
      completion: 0,
      total: generatedImageCount,
      unit: "images",
      label: "图片额度",
      auxiliaryPrompt: reviewPromptTokens,
      auxiliaryCompletion: reviewCompletionTokens,
      auxiliaryTotal: reviewTotalTokens,
      auxiliaryLabel: "质量检查 Tokens",
    },
    quality: {
      checked: qualityChecked,
      passed: qualityPassed,
      retried,
      ghostingDetected,
      unrelatedChangesDetected,
      reason: qualityReason,
    },
  };
}
