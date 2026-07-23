import { LLM_PROVIDER_CATALOG } from "./registry/providers";
import type { LlmCredentials } from "./types";

interface AttachmentLike {
  name: string;
  type: string;
  /** 兼容旧 fileParser：可以是纯 Base64，也可以是完整 Data URL。 */
  base64: string;
  /** 新的统一字段：浏览器预览使用的完整 Data URL。 */
  dataUrl?: string;
}

/**
 * 前端到服务端的 Provider 无关图片结构。
 * 不再在前端提前包装 OpenAI 的 image_url，具体协议由 Provider 适配器决定。
 */
export interface LlmRequestAttachment {
  name: string;
  mimeType: string;
  /** 纯 Base64，不包含 data: 前缀。 */
  data: string;
}

function parseDataUrl(
  value: string,
): { mimeType: string; data: string } | null {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,([\s\S]+)$/iu.exec(
    value.trim(),
  );
  if (!match) return null;

  return {
    mimeType: match[1] || "image/png",
    data: match[2].replace(/\s+/gu, ""),
  };
}

function readImageData(
  attachment: AttachmentLike,
): { mimeType: string; data: string } | null {
  const preferredValue = attachment.dataUrl?.trim() || attachment.base64.trim();
  if (!preferredValue) return null;

  const parsed = parseDataUrl(preferredValue);
  if (parsed) return parsed;

  return {
    mimeType: attachment.type || "image/png",
    data: preferredValue.replace(/\s+/gu, ""),
  };
}

/** 根据 Provider 注册表生成请求头，新增供应商时无需修改聊天 Hook。 */
export function buildLlmRequestHeaders(
  apiKeys: LlmCredentials,
  selectedModel: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-llm-model-id": selectedModel,
  };

  for (const provider of LLM_PROVIDER_CATALOG) {
    const value = apiKeys[provider.id]?.trim();
    if (value) headers[provider.requestHeader] = value;
  }
  return headers;
}

/**
 * 图片附件不进入文本 RAG，而是作为统一多模态附件发送。
 * Gateway 会从规范化后的 image part 推断 vision 能力，Provider 再各自转换格式。
 */
export function buildImageAttachmentPayload(
  attachment: AttachmentLike | null,
): LlmRequestAttachment[] | undefined {
  if (!attachment?.type.startsWith("image/")) return undefined;

  const image = readImageData(attachment);
  if (!image?.data) return undefined;

  return [
    {
      name: attachment.name,
      mimeType: image.mimeType,
      data: image.data,
    },
  ];
}
