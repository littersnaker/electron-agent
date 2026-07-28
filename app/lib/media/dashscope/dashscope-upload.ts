/**
 * 模块职责：附件上传和视频输入构建。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { Buffer } from "node:buffer";
import type { MediaAttachmentInput, MediaGenerateRequest } from "../types";
import { type DashScopeErrorPayload, type UploadPolicyPayload, getUploadApiBase, readJsonResponse, toDataUrl } from "./dashscope-image";
export function normalizeUploadFileName(value: string): string {
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
export async function uploadAttachmentForModel(
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

export async function buildVideoInput(
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

export interface AsyncTaskPayload extends DashScopeErrorPayload {
  output?: {
    task_id?: string;
    task_status?: string;
    video_url?: string;
    results?: Array<{ url?: string; video_url?: string }>;
  };
}
