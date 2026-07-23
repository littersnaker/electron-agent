export type MessageAttachment = {
  name: string;
  type: string;
  /** 可直接用于浏览器 img src 的完整 Data URL。 */
  dataUrl: string;
};

export type Message = {
  role: "user" | "assistant";
  content: string;
  /** 仅用于聊天记录展示；模型请求仍通过顶层 attachments 单独发送。 */
  attachments?: MessageAttachment[];
};

/**
 * 上传附件的统一前端结构。
 *
 * - dataUrl：浏览器预览使用的完整 Data URL；
 * - base64：纯 Base64，保留给模型请求与旧代码兼容；
 * - textContent：PDF / 文本文档提取出的正文；
 * - size：原始文件字节数。
 */
export type AttachedFile = {
  name: string;
  type: string;
  base64: string;
  dataUrl?: string;
  textContent?: string;
  size?: number;
};

export function isImageAttachment(
  attachment: Pick<AttachedFile, "type"> | null | undefined,
): boolean {
  return Boolean(attachment?.type.startsWith("image/"));
}

export function parseImageDataUrl(
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

/** 将附件统一为可直接用于 img src 的 Data URL。 */
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
 * 文件解析完成后立即归一化，确保 UI 与请求层读取的是同一份图片数据。
 */
export function normalizeAttachedFile(
  attachment: AttachedFile,
): AttachedFile {
  if (!isImageAttachment(attachment)) return attachment;

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
  if (!attachment || !isImageAttachment(attachment)) return undefined;

  const dataUrl = resolveAttachmentDataUrl(attachment);
  if (!dataUrl) return undefined;

  return [
    {
      name: attachment.name,
      type: attachment.type,
      dataUrl,
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
