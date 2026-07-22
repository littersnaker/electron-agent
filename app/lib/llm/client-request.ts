import { LLM_PROVIDER_CATALOG } from "./registry/providers";
import type { LlmCredentials } from "./types";

interface AttachmentLike {
  name: string;
  type: string;
  base64: string;
}

export interface LlmRequestAttachment {
  name: string;
  mimeType: string;
  dataUrl: string;
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
 * 图片附件不进入文本 RAG，而是作为多模态输入发送。
 * Auto Router 会据此增加 vision 能力约束。
 */
export function buildImageAttachmentPayload(
  attachment: AttachmentLike | null,
): LlmRequestAttachment[] | undefined {
  if (!attachment?.type.startsWith("image/") || !attachment.base64) {
    return undefined;
  }

  const dataUrl = attachment.base64.startsWith("data:")
    ? attachment.base64
    : `data:${attachment.type};base64,${attachment.base64}`;

  return [
    {
      name: attachment.name,
      mimeType: attachment.type,
      dataUrl,
    },
  ];
}
