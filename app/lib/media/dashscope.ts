import { Buffer } from "node:buffer";
import type { MessageAttachment } from "@/app/const/pageConst";
import { getMediaModelDefinition } from "./catalog";
import { buildImageEditPolicy } from "./edit-policy";
import { assessImageEditQuality } from "./edit-quality";
import { buildMediaPrompt } from "./prompt";
import type {
  MediaAttachmentInput,
  MediaGenerateRequest,
  MediaGenerateResult,
} from "./types";

const DEFAULT_DASHSCOPE_API_BASE = "https://dashscope.aliyuncs.com";
const IMAGE_ENDPOINT_PATH =
  "/api/v1/services/aigc/multimodal-generation/generation";
const VIDEO_ENDPOINT_PATH =
  "/api/v1/services/aigc/video-generation/video-synthesis";

interface DashScopeErrorPayload {
  code?: string;
  message?: string;
  request_id?: string;
}

interface UploadPolicyPayload extends DashScopeErrorPayload {
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

function getApiBase(): string {
  return (
    process.env.DASHSCOPE_API_BASE?.trim().replace(/\/$/u, "") ||
    DEFAULT_DASHSCOPE_API_BASE
  );
}

/**
 * 临时文件上传接口默认使用 DashScope 公共域名。
 * 如果账号使用其他地域，可单独设置 DASHSCOPE_UPLOAD_API_BASE。
 */
function getUploadApiBase(): string {
  return (
    process.env.DASHSCOPE_UPLOAD_API_BASE?.trim().replace(/\/$/u, "") ||
    DEFAULT_DASHSCOPE_API_BASE
  );
}

function getQwenApiKey(request: MediaGenerateRequest): string {
  const apiKey = request.credentials.qwen?.trim();
  if (!apiKey) {
    throw new Error("未配置百炼 API Key，无法调用图片/视频模型。");
  }
  return apiKey;
}

function toDataUrl(attachment: MediaAttachmentInput): string {
  if (attachment.dataUrl?.startsWith("data:")) return attachment.dataUrl;
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
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

function extractImageUrls(payload: unknown): string[] {
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

async function downloadImageAsAttachment(
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

interface QwenImageResponsePayload extends Record<string, unknown> {
  usage?: {
    image_count?: number;
    width?: number;
    height?: number;
  };
}

interface QwenImageAttempt {
  attachments: MessageAttachment[];
  imageCount: number;
}

/**
 * 执行单次 Qwen-Image 请求。
 *
 * 精准编辑不启用 prompt_extend，避免模型把“只改标题”扩写成整张图重绘；
 * 同时使用 negative_prompt 明确禁止重影、重复元素和双层边缘。
 */
async function callQwenImageOnce(
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
async function generateQwenImage(
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

function normalizeUploadFileName(value: string): string {
  const sanitized = value
    .replace(/[\\/]/gu, "_")
    .replace(/[^\p{L}\p{N}._-]/gu, "_")
    .slice(-120);
  return sanitized || `uploaded-media-${Date.now()}`;
}

/**
 * 将本地视频上传到百炼临时 OSS 空间。
 *
 * 视频编辑接口不接受 video 的 Base64 Data URL，只接受公网 URL 或 oss:// URL。
 * 因此先获取上传凭证，再使用 multipart/form-data 上传，并把返回的 oss:// URL
 * 传给与上传时相同的模型。该临时方案适合开发和低并发场景。
 */
async function uploadAttachmentForModel(
  attachment: MediaAttachmentInput,
  modelName: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string> {
  const policyUrl = new URL(`${getUploadApiBase()}/api/v1/uploads`);
  policyUrl.searchParams.set("action", "getPolicy");
  policyUrl.searchParams.set("model", modelName);

  const policyResponse = await fetch(policyUrl, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
    signal,
  });
  const policyPayload = await readJsonResponse<UploadPolicyPayload>(
    policyResponse,
  );
  const policy = policyPayload.data;

  if (
    !policy?.policy ||
    !policy.signature ||
    !policy.upload_dir ||
    !policy.upload_host ||
    !policy.oss_access_key_id ||
    !policy.x_oss_object_acl ||
    !policy.x_oss_forbid_overwrite
  ) {
    throw new Error("百炼临时文件上传凭证不完整。");
  }

  const bytes = Buffer.from(attachment.data, "base64");
  const maxBytes = Number(policy.max_file_size_mb || 0) * 1024 * 1024;
  if (maxBytes > 0 && bytes.byteLength > maxBytes) {
    throw new Error(
      `上传文件超过当前模型允许的 ${policy.max_file_size_mb} MB 限制。`,
    );
  }

  const fileName = normalizeUploadFileName(attachment.name);
  const objectKey = `${policy.upload_dir}/${fileName}`;
  const form = new FormData();
  form.append("OSSAccessKeyId", policy.oss_access_key_id);
  form.append("policy", policy.policy);
  form.append("Signature", policy.signature);
  form.append("key", objectKey);
  form.append("x-oss-object-acl", policy.x_oss_object_acl);
  form.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite);
  form.append("success_action_status", "200");
  // 官方要求 file 字段必须放在 multipart 表单的最后。
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: attachment.mimeType }),
    fileName,
  );

  const uploadResponse = await fetch(policy.upload_host, {
    method: "POST",
    body: form,
    signal,
  });
  if (!uploadResponse.ok) {
    throw new Error(
      `上传视频到百炼临时空间失败（HTTP ${uploadResponse.status}）。`,
    );
  }

  return `oss://${objectKey}`;
}

async function buildVideoInput(
  request: MediaGenerateRequest,
  modelName: string,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const prompt = request.prompt.trim();

  switch (request.mode) {
    case "text-to-video":
      return { prompt };
    case "image-to-video":
      if (!request.attachment) {
        throw new Error("图生视频模式必须先上传一张图片。");
      }
      return {
        prompt,
        media: [
          { type: "first_frame", url: toDataUrl(request.attachment) },
        ],
      };
    case "reference-to-video":
      if (!request.attachment) {
        throw new Error("参考生视频模式必须先上传至少一张参考图片。");
      }
      return {
        prompt,
        media: [
          { type: "reference_image", url: toDataUrl(request.attachment) },
        ],
      };
    case "video-edit": {
      if (!request.attachment) {
        throw new Error("视频编辑模式必须先上传一个视频。");
      }
      const temporaryUrl = await uploadAttachmentForModel(
        request.attachment,
        modelName,
        apiKey,
        request.signal,
      );
      return {
        prompt,
        media: [{ type: "video", url: temporaryUrl }],
      };
    }
    default:
      throw new Error(`当前模型不支持模式：${request.mode}`);
  }
}

interface AsyncTaskPayload extends DashScopeErrorPayload {
  output?: {
    task_id?: string;
    task_status?: string;
    video_url?: string;
    results?: Array<{ url?: string; video_url?: string }>;
  };
}

function extractVideoUrl(payload: AsyncTaskPayload): string | undefined {
  return (
    payload.output?.video_url ||
    payload.output?.results?.find((item) => item.video_url || item.url)
      ?.video_url ||
    payload.output?.results?.find((item) => item.video_url || item.url)?.url
  );
}

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError());
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const handleAbort = () => {
      if (timer) clearTimeout(timer);
      reject(createAbortError());
    };

    timer = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", handleAbort, { once: true });
  });
}

/**
 * 不同视频模型接受的 parameters 并不完全相同。
 * 按模型族输出最小兼容参数，避免把 Wan 专属字段传给 HappyHorse 编辑模型。
 */
function buildVideoParameters(
  request: MediaGenerateRequest,
): Record<string, unknown> {
  if (request.mode === "video-edit") {
    return {
      resolution: "720P",
      watermark: false,
      audio_setting: "auto",
    };
  }

  const base = {
    resolution: "720P",
    ratio: "16:9",
    duration: 5,
    watermark: false,
  };

  return request.modelId.includes("happyhorse")
    ? base
    : { ...base, prompt_extend: true };
}

async function waitForVideoTask(
  apiKey: string,
  taskId: string,
  signal?: AbortSignal,
): Promise<string> {
  const deadline = Date.now() + 6 * 60 * 1000;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw createAbortError();

    const response = await fetch(`${getApiBase()}/api/v1/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal,
    });
    const payload = await readJsonResponse<AsyncTaskPayload>(response);
    const status = payload.output?.task_status?.toUpperCase();

    if (status === "SUCCEEDED") {
      const videoUrl = extractVideoUrl(payload);
      if (!videoUrl) throw new Error("视频任务成功，但没有返回 video_url。");
      return videoUrl;
    }

    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      throw new Error(payload.message || `视频任务结束，状态：${status}`);
    }

    await delay(5000, signal);
  }

  throw new Error("等待视频生成超时。任务可能仍在百炼后台运行，请稍后重试。");
}

/**
 * 调用百炼异步视频接口并轮询结果。
 * 视频文件较大，不写入 SQLite；UI 下载时通过同源下载代理转发。
 */
async function generateDashScopeVideo(
  request: MediaGenerateRequest,
): Promise<MediaGenerateResult> {
  const model = getMediaModelDefinition(request.modelId);
  if (!model) throw new Error(`未注册的媒体模型：${request.modelId}`);
  const apiKey = getQwenApiKey(request);
  const input = await buildVideoInput(request, model.model, apiKey);

  const response = await fetch(`${getApiBase()}${VIDEO_ENDPOINT_PATH}`, {
    method: "POST",
    signal: request.signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
      // 使用临时 oss:// URL 时必须启用资源解析；其他模式携带该头也无副作用。
      "X-DashScope-OssResourceResolve": "enable",
    },
    body: JSON.stringify({
      model: model.model,
      input,
      parameters: buildVideoParameters(request),
    }),
  });

  const submitted = await readJsonResponse<AsyncTaskPayload>(response);
  const taskId = submitted.output?.task_id;
  if (!taskId) throw new Error("百炼视频任务提交成功，但没有返回 task_id。");

  const videoUrl = await waitForVideoTask(apiKey, taskId, request.signal);
  const fileName = `dashscope-video-${Date.now()}.mp4`;

  return {
    content: `已使用 ${model.name} 完成视频生成。视频临时地址通常只保留 24 小时，请及时下载。`,
    attachments: [
      {
        name: fileName,
        downloadName: fileName,
        type: "video/mp4",
        assetKind: "video",
        url: videoUrl,
      },
    ],
    usage: {
      prompt: 0,
      completion: 0,
      total: 1,
      unit: "videos",
      label: "视频额度",
    },
  };
}

export async function generateMedia(
  request: MediaGenerateRequest,
): Promise<MediaGenerateResult> {
  const model = getMediaModelDefinition(request.modelId);
  if (!model) throw new Error(`未注册的媒体模型：${request.modelId}`);
  if (!model.modes.includes(request.mode)) {
    throw new Error(`${model.name} 不支持 ${request.mode} 模式。`);
  }

  return model.protocol === "qwen-image-sync"
    ? generateQwenImage(request)
    : generateDashScopeVideo(request);
}
