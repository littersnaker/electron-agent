"use client";
/**
 * 知识库文档列表：空状态、文档卡片与删除按钮。
 */
import type { KnowledgeDocument } from "./knowledge-types";
import { formatBytes, statusLabel } from "./knowledge-types";

interface KnowledgeDocumentListProps {
  /** 全部文档 */
  documents: KnowledgeDocument[];
  /** 正在删除的文档 ID */
  deletingId: string | null;
  /** 点击删除的回调 */
  onDelete: (documentId: string) => void;
}

/** 文档列表主组件。 */
export function KnowledgeDocumentList({
  documents,
  deletingId,
  onDelete,
}: KnowledgeDocumentListProps) {
  if (documents.length === 0) {
    return (
      <div
        className="flex h-36 flex-col items-center justify-center rounded-[18px] border border-dashed"
        style={{
          borderColor: "var(--border)",
          color: "var(--text-tertiary)",
        }}
      >
        <p className="text-[12px]">还没有知识库文档</p>
        <p className="mt-1 text-[11px]">上传后 QA 问答会自动检索这里的内容</p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {documents.map((document) => (
        <div
          key={document.id}
          className="flex items-center gap-3 rounded-[16px] border px-4 py-3"
          style={{
            background: "var(--glass-soft)",
            borderColor: "var(--border)",
          }}
        >
          <div
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border"
            style={{
              background: "var(--glass)",
              borderColor: "var(--border)",
              color: "var(--accent-blue)",
            }}
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
              <path
                d="M5 3.5h7l3 3v10H5v-13Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <path
                d="M12 3.5v3h3M8 10h4M8 12.5h4"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[12px] font-medium">{document.filename}</span>
              <span
                className="shrink-0 rounded-full px-2 py-0.5 text-[10px]"
                style={{
                  background:
                    document.status === "ready"
                      ? "rgba(48,209,88,0.12)"
                      : document.status === "error"
                        ? "rgba(255,69,58,0.12)"
                        : "rgba(255,196,0,0.12)",
                  color:
                    document.status === "ready"
                      ? "#34d97b"
                      : document.status === "error"
                        ? "#ff6961"
                        : "#f0c648",
                }}
              >
                {statusLabel(document.status)}
              </span>
            </div>
            <div className="mt-0.5 truncate text-[10px]" style={{ color: "var(--text-tertiary)" }}>
              {formatBytes(document.size)}
              {document.chunkCount > 0 ? ` · ${document.chunkCount} 块` : ""}
              {document.errorMessage ? ` · ${document.errorMessage}` : ""}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onDelete(document.id)}
            disabled={deletingId === document.id}
            className="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-[10px] border transition-all duration-150 hover:bg-[rgba(255,69,58,0.1)] hover:border-[rgba(255,69,58,0.25)] active:scale-[0.94] disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              background: "var(--glass)",
              borderColor: "var(--border)",
              color: "var(--text-tertiary)",
            }}
            title="删除文档"
            aria-label={`删除 ${document.filename}`}
          >
            <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
              <path
                d="M5.5 6.5h9M8 6.5V5h4v1.5M7 6.5l.5 8.5h5l.5-8.5"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
}
