// 模块说明：知识库页面的共享类型与格式化工具。

/** 知识库中单个上传文档的元数据。 */
export interface KnowledgeDocument {
  id: string;
  filename: string;
  size: number;
  status: "pending" | "ready" | "error";
  chunkCount: number;
  errorMessage: string;
  createdAt: string;
  updatedAt: string;
}

/** 知识库与 Jina 配置状态（不含密钥）。 */
export interface KnowledgeStatus {
  enabled: boolean;
  hasApiKey: boolean;
  embeddingModel: string;
  rerankModel: string;
  recallK: number;
  topK: number;
  parentChildEnabled: boolean;
  documentCount: number;
  usage: {
    totalTokens: number;
    items: Array<{ model: string; operation: string; totalTokens: number }>;
  };
}

/** 页面底部一次性提示的数据结构。 */
export interface ToastData {
  kind: "success" | "error";
  message: string;
}

/** 上传接口支持的文件扩展名白名单。 */
export const ACCEPT_EXTENSIONS = ".md,.txt,.pdf,.docx";

/** Jina 免费额度估算值（非商用，embedding 与重排共用）。 */
export const FREE_TOKEN_QUOTA = 10_000_000;

/** 把字节数格式化为人类可读大小。 */
export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** 把 Token 数格式化为紧凑的 K/M 显示。 */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** 把文档索引状态转换成中文标签。 */
export function statusLabel(status: KnowledgeDocument["status"]): string {
  if (status === "ready") return "已就绪";
  if (status === "error") return "失败";
  return "待索引";
}
