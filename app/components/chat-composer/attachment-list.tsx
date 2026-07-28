"use client";

import {
  isImageAttachment,
  isVideoAttachment,
  resolveAttachmentDataUrl,
} from "../../constants/page-constants";
import type { AttachedFile } from "../../constants/page-constants";

interface AttachmentListProps {
  attachments: readonly AttachedFile[];
  onRemove: (attachmentId: string) => void;
  label: string;
}

function formatBytes(size?: number): string {
  if (!size) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function resolveSourceLabel(attachment: AttachedFile): string {
  switch (attachment.sourceKind) {
    case "clipboard":
      return "剪贴板";
    case "drop-directory":
      return "文件夹";
    case "drop-file":
      return "拖拽";
    default:
      return "文件";
  }
}

export function AttachmentList({
  attachments,
  onRemove,
  label,
}: AttachmentListProps) {
  if (attachments.length === 0) return null;

  return (
    <div
      className="mb-2 rounded-[16px] border p-2.5"
      style={{
        background: "var(--glass)",
        borderColor: "var(--border)",
        color: "var(--text-secondary)",
      }}
    >
      <div className="mb-2 flex items-center justify-between px-0.5">
        <span className="text-[10px] font-medium uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
          {label} · {attachments.length}
        </span>
        <span className="text-[9px] text-[var(--text-quaternary)]">
          支持粘贴图片、拖入文件与文件夹
        </span>
      </div>

      <div className="grid max-h-52 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
        {attachments.map((attachment) => {
          const imagePreview = isImageAttachment(attachment);
          const videoPreview = isVideoAttachment(attachment);
          const previewUrl =
            imagePreview || videoPreview
              ? resolveAttachmentDataUrl(attachment)
              : "";

          return (
            <div
              key={attachment.id}
              className="flex min-w-0 items-center gap-2 rounded-[12px] border p-2"
              style={{
                background: "var(--glass-soft)",
                borderColor: "var(--border)",
              }}
            >
              <div
                className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-[9px] border text-[9px] text-[var(--text-tertiary)]"
                style={{
                  background: "var(--glass-black)",
                  borderColor: "var(--border)",
                }}
              >
                {imagePreview ? (
                  // eslint-disable-next-line @next/next/no-img-element -- Data URL 预览不适合 Next Image 优化器。
                  <img
                    src={previewUrl}
                    alt={attachment.name}
                    className="h-full w-full object-cover"
                  />
                ) : videoPreview ? (
                  <video
                    src={previewUrl}
                    className="h-full w-full object-cover"
                    muted
                  />
                ) : (
                  <span>
                    {attachment.sourceKind === "drop-directory"
                      ? "目录"
                      : "文件"}
                  </span>
                )}
              </div>

              <div className="min-w-0 flex-1">
                <div
                  className="truncate text-[11px] font-medium text-[var(--text-primary)]"
                  title={attachment.relativePath || attachment.name}
                >
                  {attachment.relativePath || attachment.name}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-[9px] text-[var(--text-tertiary)]">
                  <span>{resolveSourceLabel(attachment)}</span>
                  <span>·</span>
                  <span>{formatBytes(attachment.size)}</span>
                </div>
              </div>

              <button
                type="button"
                onClick={() => onRemove(attachment.id)}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[15px] text-[var(--text-tertiary)] transition-colors hover:bg-[var(--glass-hover)] hover:text-[var(--text-primary)]"
                aria-label={`移除 ${attachment.name}`}
                title={`移除 ${attachment.name}`}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
