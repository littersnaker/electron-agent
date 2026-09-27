// 模块说明：全站巡检聊天卡片——多页面缩略图 + 逐页视觉模型结论。
"use client";

import { useState } from "react";
import type { VisualAuditCardData } from "../../constants/page-constants";

const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  border: "var(--border)",
  blue: "var(--accent-blue)",
  red: "var(--accent-red)",
  amber: "var(--accent-amber)",
};

const STATUS_META: Record<
  VisualAuditCardData["pages"][number]["status"],
  { label: string; color: string }
> = {
  reviewed: { label: "已审查", color: "var(--accent-green, #30d158)" },
  captured: { label: "待审查", color: "var(--text-tertiary)" },
  captureFailed: { label: "截图失败", color: "var(--accent-red, #ff6961)" },
  reviewFailed: { label: "审查失败", color: "var(--accent-amber, #ffd60a)" },
};

/** 归一化巡检数据：旧会话或损坏消息缺字段时兜底。 */
function normalizeCard(card: VisualAuditCardData | undefined): VisualAuditCardData | null {
  if (!card || typeof card !== "object" || !Array.isArray(card.pages)) return null;
  const pages = card.pages
    .filter((page) => page && typeof page === "object")
    .map((page) => ({
      path: String(page.path || "/"),
      frameCount: Math.max(0, Number(page.frameCount) || 0),
      status: (page.status in STATUS_META
        ? page.status
        : "captured") as VisualAuditCardData["pages"][number]["status"],
      content: String(page.content || ""),
      captureError: String(page.captureError || ""),
      reviewError: String(page.reviewError || ""),
      thumbnails: Array.isArray(page.thumbnails)
        ? page.thumbnails.filter(
            (item): item is string => typeof item === "string" && item.length > 0,
          )
        : [],
    }));
  return {
    url: String(card.url || ""),
    model: String(card.model || ""),
    createdAt: String(card.createdAt || ""),
    pages,
  };
}

/** 聊天流里的全站巡检卡片。 */
export default function VisualAuditCard({ card }: { card?: VisualAuditCardData }) {
  const data = normalizeCard(card);
  const [zoomed, setZoomed] = useState<string | null>(null);
  if (!data || data.pages.length === 0) return null;

  const reviewed = data.pages.filter((page) => page.status === "reviewed").length;

  return (
    <section
      className="mt-2 overflow-hidden rounded-[18px] border"
      style={{
        background: "linear-gradient(180deg, var(--glass), var(--glass-soft))",
        borderColor: COLORS.border,
      }}
    >
      <header className="flex items-center justify-between gap-3 px-4 pb-2 pt-3">
        <div className="flex items-center gap-2">
          <span
            className="flex h-6 w-6 items-center justify-center rounded-lg text-[12px]"
            style={{ background: "rgba(10,132,255,0.14)", color: COLORS.blue }}
          >
            🔍
          </span>
          <h4 className="text-[13px] font-semibold" style={{ color: COLORS.text }}>
            全站巡检 · {data.pages.length} 页（{reviewed} 页完成审查）
          </h4>
        </div>
        {data.model ? (
          <span className="shrink-0 text-[10px]" style={{ color: COLORS.textSubtle }}>
            {data.model}
          </span>
        ) : null}
      </header>

      <div className="flex flex-col gap-2 px-4 pb-3">
        {data.pages.map((page, pageIndex) => {
          const meta = STATUS_META[page.status];
          return (
            <div
              key={`${data.createdAt}-${pageIndex}`}
              className="rounded-xl border px-3 py-2"
              style={{ background: "var(--glass)", borderColor: COLORS.border }}
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span
                  className="truncate text-[11px] font-medium"
                  style={{ color: COLORS.text }}
                  title={page.path}
                >
                  {page.path || "/"}
                </span>
                <span className="shrink-0 text-[9px]" style={{ color: meta.color }}>
                  {meta.label}
                </span>
              </div>
              {page.thumbnails.length > 0 ? (
                <div className="mb-1.5 flex gap-1.5 overflow-x-auto">
                  {page.thumbnails.map((thumbnail, frameIndex) => (
                    <button
                      key={`${pageIndex}-${frameIndex}`}
                      type="button"
                      onClick={() => setZoomed(thumbnail)}
                      className="shrink-0 cursor-zoom-in overflow-hidden rounded-lg border transition-transform hover:scale-[1.03]"
                      style={{ borderColor: COLORS.border }}
                      title={`第 ${frameIndex + 1} 屏（点击放大）`}
                    >
                      <img
                        src={
                          thumbnail.startsWith("data:")
                            ? thumbnail
                            : `data:image/jpeg;base64,${thumbnail}`
                        }
                        alt={`${page.path} 第 ${frameIndex + 1} 屏`}
                        className="h-[56px] w-[90px] object-cover object-top"
                      />
                    </button>
                  ))}
                </div>
              ) : null}
              {page.captureError ? (
                <p className="text-[10px]" style={{ color: COLORS.red }}>
                  {page.captureError}
                </p>
              ) : null}
              {page.reviewError ? (
                <p className="text-[10px]" style={{ color: COLORS.amber }}>
                  {page.reviewError}
                </p>
              ) : null}
              {page.content ? (
                <pre
                  className="text-[11px] leading-relaxed whitespace-pre-wrap font-sans"
                  style={{ color: COLORS.textMuted }}
                >
                  {page.content}
                </pre>
              ) : null}
            </div>
          );
        })}
      </div>

      {zoomed ? (
        <div
          role="presentation"
          onClick={() => setZoomed(null)}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center p-8"
          style={{ background: "rgba(0,0,0,0.72)" }}
        >
          <img
            src={zoomed}
            alt="截图放大"
            className="max-h-full max-w-full rounded-xl border"
            style={{ borderColor: "var(--border-strong)" }}
          />
        </div>
      ) : null}
    </section>
  );
}
