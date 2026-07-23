export type AttachmentAssetKind = "image" | "video" | "file";

export type MessageAttachment = {
  name: string;
  type: string;
  /** 本地生成结果或用户上传文件使用 Data URL，能直接预览和下载。 */
  dataUrl?: string;
  /** 视频等大文件可保留百炼临时 URL，避免把大文件写入 SQLite。 */
  url?: string;
  assetKind?: AttachmentAssetKind;
  downloadName?: string;
};

export type Message = {
  role: "user" | "assistant";
  content: string;
  /** 用户附件与 AI 生成结果使用同一种结构，UI 不需要写两套渲染逻辑。 */
  attachments?: MessageAttachment[];
};

export type AttachedFile = {
  name: string;
  type: string;
  base64: string;
  dataUrl?: string;
  textContent?: string;
  size?: number;
};

export type MediaMode =
  | "text-to-image"
  | "image-edit"
  | "text-to-video"
  | "image-to-video"
  | "reference-to-video"
  | "video-edit";

export type ComposerMode = "chat" | MediaMode;

export type TypographyPolicy =
  | "avoid-generated-text"
  | "strict-short-text"
  | "model-default";

/**
 * 图片编辑保真策略。
 *
 * - precise：尽量只改目标区域，适合 UI 截图、商品图和文字替换；
 * - balanced：保留主要结构，同时允许模型做必要的局部重绘；
 * - creative：允许大幅重构，适合风格迁移和创意改造。
 */
export type ImageEditFidelity = "precise" | "balanced" | "creative";

export function isImageMimeType(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.startsWith("image/"));
}

export function isVideoMimeType(mimeType: string | undefined): boolean {
  return Boolean(mimeType?.startsWith("video/"));
}

export function isImageAttachment(
  attachment: Pick<AttachedFile, "type"> | null | undefined,
): boolean {
  return isImageMimeType(attachment?.type);
}

export function isVideoAttachment(
  attachment: Pick<AttachedFile, "type"> | null | undefined,
): boolean {
  return isVideoMimeType(attachment?.type);
}

export function parseImageDataUrl(
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

/** 将附件统一为可直接用于 img / video src 的 Data URL。 */
export function resolveAttachmentDataUrl(
  attachment: Pick<AttachedFile, "type" | "base64" | "dataUrl">,
): string {
  const existingDataUrl = attachment.dataUrl?.trim();
  if (existingDataUrl?.startsWith("data:")) return existingDataUrl;

  const legacyValue = attachment.base64.trim();
  if (legacyValue.startsWith("data:")) return legacyValue;

  const mimeType = attachment.type || "application/octet-stream";
  return legacyValue ? `data:${mimeType};base64,${legacyValue}` : "";
}

/**
 * 文件读取后立即归一化，保证预览、聊天请求和媒体请求读取同一份数据。
 */
export function normalizeAttachedFile(
  attachment: AttachedFile,
): AttachedFile {
  if (!isImageAttachment(attachment) && !isVideoAttachment(attachment)) {
    return attachment;
  }

  const dataUrl = resolveAttachmentDataUrl(attachment);
  const parsed = dataUrl ? parseImageDataUrl(dataUrl) : null;

  return {
    ...attachment,
    type: parsed?.mimeType || attachment.type,
    dataUrl,
    base64: parsed?.data || attachment.base64,
  };
}

export function toMessageAttachment(
  attachment: AttachedFile | null,
): MessageAttachment[] | undefined {
  if (!attachment) return undefined;
  if (!isImageAttachment(attachment) && !isVideoAttachment(attachment)) {
    return undefined;
  }

  const dataUrl = resolveAttachmentDataUrl(attachment);
  if (!dataUrl) return undefined;

  return [
    {
      name: attachment.name,
      type: attachment.type,
      dataUrl,
      assetKind: isVideoAttachment(attachment) ? "video" : "image",
      downloadName: attachment.name,
    },
  ];
}

export type ChatSession = {
  id: string;
  title: string;
  messages: Message[];
  mode: "qa" | "code";
  projectId: string | null;
  updatedAt: string;
};

export type WorkspaceProject = {
  id: string;
  name: string;
  rootPath: string;
  indexStatus: "idle" | "indexing" | "ready" | "error";
  indexedFileCount: number;
  lastOpenedAt: string;
};

export interface StreamPacket {
  type?:
    | "TEXT"
    | "STATUS"
    | "TOOL_STATUS"
    | "DIFF_READY"
    | "INTERACTIVE_REQUEST";
  content?: string;
  payload?: unknown;
}

export const ToolNameMap: Record<string, string> = {
  search_project_index: "正在检索本地代码索引...",
  list_directory: "🔍 正在扫描文件目录...",
  propose_file_change: "✍️ 正在构思代码修改...",
  read_file_from_disk: "📖 正在读取文件内容...",
  run_terminal_command: "⚙️ 正在路由终端指令...",
  apply_file_change: "✅ 正在应用代码修改...",
  get_diff: "📊 正在对比代码差异...",
  search_codebase: "🔎 正在搜索代码库...",
  get_code_outline: "📝 正在分析代码结构...",
  get_local_time: "⏰ 正在获取本地时间...",
  get_file_content: "📄 正在获取文件内容...",
};
