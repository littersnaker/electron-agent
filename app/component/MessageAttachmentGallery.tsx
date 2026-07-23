/* eslint-disable @next/next/no-img-element */
"use client";

import type { MessageAttachment } from "../const/pageConst";
import {
  isImageMimeType,
  isVideoMimeType,
} from "../const/pageConst";

interface MessageAttachmentGalleryProps {
  attachments?: MessageAttachment[];
  compact?: boolean;
}

function buildDownloadUrl(attachment: MessageAttachment): string {
  if (attachment.dataUrl) return attachment.dataUrl;
  if (!attachment.url) return "";

  const name = attachment.downloadName || attachment.name;
  return `/api/media/download?url=${encodeURIComponent(
    attachment.url,
  )}&name=${encodeURIComponent(name)}`;
}

/**
 * 用户上传素材和 AI 生成结果共用一个展示组件。
 * 生成图片使用 Data URL，能够长期保存在本地会话；视频使用同源下载代理。
 */
export default function MessageAttachmentGallery({
  attachments = [],
  compact = false,
}: MessageAttachmentGalleryProps) {
  if (!attachments.length) return null;

  return (
    <div className={`grid gap-3 ${compact ? "mb-2" : "mt-3"}`}>
      {attachments.map((attachment, index) => {
        const source = attachment.dataUrl || attachment.url || "";
        const image =
          attachment.assetKind === "image" ||
          isImageMimeType(attachment.type);
        const video =
          attachment.assetKind === "video" ||
          isVideoMimeType(attachment.type);
        const downloadUrl = buildDownloadUrl(attachment);

        return (
          <div
            key={`${attachment.name}-${index}-${source.slice(0, 24)}`}
            className="overflow-hidden rounded-[14px] border"
            style={{
              background: compact ? "rgba(0,0,0,0.1)" : "var(--glass-soft)",
              borderColor: compact
                ? "rgba(255,255,255,0.2)"
                : "var(--border)",
            }}
          >
            {image && source && (
              <img
                src={source}
                alt={attachment.name}
                className="block max-h-[480px] w-full object-contain"
              />
            )}

            {video && source && (
              <video
                src={source}
                controls
                preload="metadata"
                className="block max-h-[480px] w-full bg-black object-contain"
              />
            )}

            {!image && !video && (
              <div className="px-3 py-4 text-[12px]">
                {attachment.name}
              </div>
            )}

            {!compact && (
              <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <div
                    className="truncate text-[11px] font-medium"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {attachment.name}
                  </div>
                  <div
                    className="mt-0.5 text-[9px]"
                    style={{ color: "var(--text-tertiary)" }}
                  >
                    {attachment.type || attachment.assetKind || "media"}
                  </div>
                </div>

                {downloadUrl && (
                  <a
                    href={downloadUrl}
                    download={attachment.downloadName || attachment.name}
                    className="shrink-0 rounded-[9px] border px-3 py-1.5 text-[10px] font-semibold transition-colors hover:bg-[var(--glass-hover)]"
                    style={{
                      borderColor: "var(--border)",
                      color: "var(--text-primary)",
                    }}
                  >
                    下载
                  </a>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
