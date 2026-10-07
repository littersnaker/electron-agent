// 模块说明：负责 MessageAttachmentGallery 用户界面组件。
"use client";

import { memo, useEffect, useState } from "react";
import type { MessageAttachment } from "../constants/page-constants";
import { isImageMimeType, isVideoMimeType } from "../constants/page-constants";
import { buildApiUrl } from "../lib/api-client";

interface MessageAttachmentGalleryProps {
  attachments?: MessageAttachment[];
  compact?: boolean;
}

function buildDownloadUrl(attachment: MessageAttachment): string {
  if (attachment.dataUrl) return attachment.dataUrl;
  if (!attachment.url) return "";

  const name = attachment.downloadName || attachment.name;
  if (attachment.url?.startsWith("/api/")) {
    return buildApiUrl(attachment.url);
  }
  return buildApiUrl(
    `/api/media/download?url=${encodeURIComponent(
      attachment.url,
    )}&name=${encodeURIComponent(name)}`,
  );
}

function isCharacterSheet(attachment: MessageAttachment): boolean {
  return attachment.downloadName?.startsWith("角色设定-") === true;
}

/** 附件分组：漫剧结果按「成片/字幕/分镜/角色」组织，普通上传仍走单列表。 */
interface AttachmentGroups {
  videos: Array<{ attachment: MessageAttachment; source: string }>;
  characterSheets: Array<{ attachment: MessageAttachment; source: string }>;
  images: Array<{ attachment: MessageAttachment; source: string }>;
  files: Array<{ attachment: MessageAttachment; source: string }>;
}

function groupAttachments(attachments: MessageAttachment[]): AttachmentGroups {
  const groups: AttachmentGroups = { videos: [], characterSheets: [], images: [], files: [] };
  for (const attachment of attachments) {
    const rawSource = attachment.dataUrl || attachment.url || "";
    const source = attachment.dataUrl ? rawSource : buildApiUrl(rawSource);
    const image = attachment.assetKind === "image" || isImageMimeType(attachment.type);
    const video = attachment.assetKind === "video" || isVideoMimeType(attachment.type);
    const entry = { attachment, source };
    if (video) groups.videos.push(entry);
    else if (image && isCharacterSheet(attachment)) groups.characterSheets.push(entry);
    else if (image) groups.images.push(entry);
    else groups.files.push(entry);
  }
  return groups;
}

/** 视频容器：加载完成前显示占位背景，避免黑块突兀。 */
function VideoCard({ source, name }: { source: string; name: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div className="relative">
      {!loaded && (
        <div
          className="message-media flex aspect-video w-full animate-pulse items-center justify-center rounded-t-[14px] bg-black/60"
          style={{ color: "var(--text-tertiary)" }}
        >
          <span className="text-[11px]">视频加载中…</span>
        </div>
      )}
      <video
        src={source}
        controls
        preload="metadata"
        onLoadedMetadata={() => setLoaded(true)}
        className={`message-media block max-h-[480px] w-full bg-black object-contain ${loaded ? "" : "hidden"}`}
        aria-label={name}
      />
    </div>
  );
}

/**
 * 用户上传素材和 AI 生成结果共用一个展示组件。
 * 生成图片使用 Data URL，能够长期保存在本地会话；视频使用同源下载代理。
 * 漫剧等多附件结果自动按「成片 → 字幕 → 分镜 → 角色设定」分组，成片置顶。
 */
function MessageAttachmentGallery({
  attachments = [],
  compact = false,
}: MessageAttachmentGalleryProps) {
  const [zoomed, setZoomed] = useState<string | null>(null);
  useEffect(() => {
    if (!zoomed) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomed(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomed]);

  if (!attachments.length) return null;

  const needsGrouping = attachments.length > 4 && attachments.some((a) => a.assetKind === "video");
  const downloadUrlOf = (attachment: MessageAttachment) => buildDownloadUrl(attachment);

  const renderMediaCard = (
    attachment: MessageAttachment,
    source: string,
    index: number,
    { thumbnail = false }: { thumbnail?: boolean } = {},
  ) => {
    const image = attachment.assetKind === "image" || isImageMimeType(attachment.type);
    const video = attachment.assetKind === "video" || isVideoMimeType(attachment.type);
    const downloadUrl = downloadUrlOf(attachment);
    return (
      <div
        key={`${attachment.name}-${index}-${source.slice(0, 24)}`}
        className="message-media-card overflow-hidden rounded-[14px] border"
        style={{
          background: compact ? "rgba(0,0,0,0.1)" : "var(--glass-soft)",
          borderColor: compact ? "rgba(255,255,255,0.2)" : "var(--border)",
        }}
      >
        {image && source && (
          <button
            type="button"
            onClick={() => setZoomed(source)}
            className="block w-full cursor-zoom-in"
            title="点击放大"
          >
            <img
              src={source}
              alt={attachment.name}
              className={`message-media block w-full object-contain ${
                thumbnail ? "h-[132px] object-cover" : "max-h-[480px]"
              }`}
              loading="lazy"
              decoding="async"
              draggable={false}
            />
          </button>
        )}

        {video && source && <VideoCard source={source} name={attachment.name} />}

        {!image && !video && <div className="px-3 py-4 text-[12px]">{attachment.name}</div>}

        {!compact && (
          <div className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <div
                className="truncate text-[11px] font-medium"
                style={{ color: "var(--text-primary)" }}
              >
                {attachment.name}
              </div>
              <div className="mt-0.5 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                {attachment.type || attachment.assetKind || "media"}
              </div>
            </div>

            {downloadUrl && (
              <a
                href={downloadUrl}
                download={attachment.downloadName || attachment.name}
                className="flex h-8 shrink-0 items-center rounded-[9px] border px-3 text-[10px] font-semibold transition-colors hover:bg-[var(--glass-hover)]"
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
  };

  const groupHeader = (title: string, count: number) => (
    <div
      className="flex items-center gap-2 text-[11px] font-semibold"
      style={{ color: "var(--text-secondary)" }}
    >
      {title}
      <span
        className="rounded-full px-1.5 py-0.5 text-[10px]"
        style={{ background: "var(--glass)", color: "var(--text-tertiary)" }}
      >
        {count}
      </span>
    </div>
  );

  // 少量附件（普通上传）保持单列表，不做分组。
  if (!needsGrouping) {
    return (
      <div className={`grid gap-3 ${compact ? "mb-2" : "mt-3"}`}>
        {attachments.map((attachment, index) =>
          renderMediaCard(
            attachment,
            attachment.dataUrl || buildApiUrl(attachment.url || ""),
            index,
          ),
        )}
        {zoomed && (
          <div
            role="dialog"
            aria-modal="true"
            onClick={() => setZoomed(null)}
            className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center p-8"
            style={{ background: "rgba(0,0,0,0.72)" }}
          >
            <img
              src={zoomed}
              alt="放大查看"
              className="max-h-full max-w-full rounded-xl border"
              style={{ borderColor: "var(--border-strong)" }}
            />
          </div>
        )}
      </div>
    );
  }

  const groups = groupAttachments(attachments);
  return (
    <div className={`flex flex-col gap-4 ${compact ? "mb-2" : "mt-3"}`}>
      {groups.videos.length > 0 && (
        <section className="flex flex-col gap-3">
          {groupHeader("成片与视频", groups.videos.length)}
          {groups.videos.map(({ attachment, source }, index) =>
            renderMediaCard(attachment, source, index),
          )}
        </section>
      )}

      {groups.files.length > 0 && (
        <details
          className="rounded-[14px] border px-3 py-2"
          style={{ borderColor: "var(--border)", background: "var(--glass-soft)" }}
        >
          <summary
            className="cursor-pointer text-[11px] font-semibold select-none"
            style={{ color: "var(--text-secondary)" }}
          >
            字幕与文件（{groups.files.length}）
          </summary>
          <div className="mt-2 flex flex-col gap-2">
            {groups.files.map(({ attachment, source }, index) =>
              renderMediaCard(attachment, source, index),
            )}
          </div>
        </details>
      )}

      {groups.images.length > 0 && (
        <section className="flex flex-col gap-2">
          {groupHeader("分镜画面", groups.images.length)}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {groups.images.map(({ attachment, source }, index) =>
              renderMediaCard(attachment, source, index, { thumbnail: true }),
            )}
          </div>
        </section>
      )}

      {groups.characterSheets.length > 0 && (
        <section className="flex flex-col gap-2">
          {groupHeader("角色设定图", groups.characterSheets.length)}
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {groups.characterSheets.map(({ attachment, source }, index) =>
              renderMediaCard(attachment, source, index, { thumbnail: true }),
            )}
          </div>
        </section>
      )}

      {zoomed && (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setZoomed(null)}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center p-8"
          style={{ background: "rgba(0,0,0,0.72)" }}
        >
          <img
            src={zoomed}
            alt="放大查看"
            className="max-h-full max-w-full rounded-xl border"
            style={{ borderColor: "var(--border-strong)" }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * 附件内容通常包含大尺寸图片或视频，使用 memo 避免父级主题状态变化时重复渲染。
 */
export default memo(MessageAttachmentGallery);
