import { NextResponse } from "next/server";
import type {
  ImageEditFidelity,
  MediaMode,
  TypographyPolicy,
} from "@/app/const/pageConst";
import { resolveLlmCredentials } from "@/app/lib/llm/credentials";
import { getMediaModelDefinition } from "@/app/lib/media/catalog";
import { generateMedia } from "@/app/lib/media/dashscope";
import type { MediaAttachmentInput } from "@/app/lib/media/types";

export const runtime = "nodejs";

interface FrontendAttachment {
  name?: string;
  mimeType?: string;
  data?: string;
  dataUrl?: string;
}

interface MediaGenerateBody {
  prompt?: string;
  mode?: MediaMode;
  modelId?: string;
  size?: string;
  attachment?: FrontendAttachment | null;
  typographyPolicy?: TypographyPolicy;
  imageEditFidelity?: ImageEditFidelity;
  enableQualityGuard?: boolean;
}

function parseDataUrl(
  value: string,
): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/iu.exec(
    value.trim(),
  );
  if (!match) return null;

  return {
    mimeType: match[1] || "application/octet-stream",
    data: match[2].replace(/\s+/gu, ""),
  };
}

function normalizeAttachment(
  attachment: FrontendAttachment | null | undefined,
): MediaAttachmentInput | undefined {
  if (!attachment) return undefined;

  const dataUrl = attachment.dataUrl?.trim();
  const parsed = dataUrl ? parseDataUrl(dataUrl) : null;
  const mimeType = parsed?.mimeType || attachment.mimeType?.trim() || "";
  const data = (parsed?.data || attachment.data?.trim() || "").replace(
    /\s+/gu,
    "",
  );

  if (!mimeType || !data) return undefined;

  return {
    name: attachment.name?.trim() || "uploaded-media",
    mimeType,
    data,
    dataUrl,
  };
}

function maxAttachmentSizeBytes(mode: MediaMode): number | null {
  switch (mode) {
    case "image-edit":
      return 10 * 1024 * 1024;
    case "image-to-video":
    case "reference-to-video":
      return 20 * 1024 * 1024;
    case "video-edit":
      return 100 * 1024 * 1024;
    default:
      return null;
  }
}

function validateAttachmentForMode(
  mode: MediaMode,
  attachment: MediaAttachmentInput | undefined,
): void {
  if (
    mode === "image-edit" ||
    mode === "image-to-video" ||
    mode === "reference-to-video"
  ) {
    if (!attachment?.mimeType.startsWith("image/")) {
      throw new Error("当前模式需要上传图片素材。");
    }
  }

  if (mode === "video-edit" && !attachment?.mimeType.startsWith("video/")) {
    throw new Error("视频编辑模式需要上传视频素材。");
  }

  const maxSize = maxAttachmentSizeBytes(mode);
  const estimatedBytes = attachment
    ? Math.floor((attachment.data.length * 3) / 4)
    : 0;
  if (maxSize && estimatedBytes > maxSize) {
    throw new Error(
      `素材文件不能超过 ${Math.round(maxSize / 1024 / 1024)} MB。`,
    );
  }
}

/**
 * 图片/视频生成使用独立 Route，不与文本 SSE 混用。
 * 媒体接口通常返回图片 URL 或异步 task_id，独立处理更便于轮询、下载和错误恢复。
 */
export async function POST(request: Request): Promise<Response> {
  try {
    const body = (await request.json()) as MediaGenerateBody;
    const modelId =
      body.modelId?.trim() ||
      request.headers.get("x-llm-model-id")?.trim() ||
      "qwen:qwen-image-2.0-pro-2026-06-22";
    const mode = body.mode || "text-to-image";
    const model = getMediaModelDefinition(modelId);

    if (!model) {
      return NextResponse.json(
        { error: `未注册的媒体模型：${modelId}` },
        { status: 400 },
      );
    }

    const attachment = normalizeAttachment(body.attachment);
    validateAttachmentForMode(mode, attachment);

    const result = await generateMedia({
      credentials: resolveLlmCredentials(request.headers),
      modelId,
      mode,
      prompt: body.prompt?.trim() || "",
      typographyPolicy: body.typographyPolicy || "avoid-generated-text",
      imageEditFidelity: body.imageEditFidelity || "precise",
      enableQualityGuard: body.enableQualityGuard !== false,
      attachment,
      size: body.size?.trim(),
      signal: request.signal,
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "媒体生成请求失败",
      },
      { status: 400 },
    );
  }
}
