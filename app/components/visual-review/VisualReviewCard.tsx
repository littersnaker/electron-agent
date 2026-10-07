// 模块说明：视觉 Review 聊天卡片——滚动截图缩略图行 + 视觉模型结论文本。
"use client";

import { useState } from "react";
import type { VisualReviewCardData } from "../../constants/page-constants";

const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  border: "var(--border)",
  blue: "var(--accent-blue)",
};

/** 归一化留档数据：旧会话或损坏消息缺字段时兜底，避免整页崩溃。 */
function normalizeCard(card: VisualReviewCardData | undefined): VisualReviewCardData | null {
  if (!card || typeof card !== "object") return null;
  const thumbnails = Array.isArray(card.thumbnails)
    ? card.thumbnails.filter((item) => typeof item === "string" && item.length > 0)
    : [];
  return {
    url: String(card.url || ""),
    frameCount: Math.max(0, Number(card.frameCount) || thumbnails.length),
    thumbnails,
    content: String(card.content || ""),
    model: String(card.model || ""),
    createdAt: String(card.createdAt || ""),
  };
}

/** 聊天流里的视觉 Review 卡片。 */
export default function VisualReviewCard({ card }: { card?: VisualReviewCardData }) {
  const data = normalizeCard(card);
  const [zoomed, setZoomed] = useState<string | null>(null);
  if (!data) return null;

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
            style={{ background: "var(--accent-blue-soft-strong)", color: COLORS.blue }}
          >
            👁
          </span>
          <h4 className="text-[13px] font-semibold" style={{ color: COLORS.text }}>
            视觉 Review · {data.frameCount} 帧截图
          </h4>
        </div>
        {data.model ? (
          <span className="shrink-0 text-[10px]" style={{ color: COLORS.textSubtle }}>
            {data.model}
          </span>
        ) : null}
      </header>

      {data.thumbnails.length > 0 ? (
        <div className="flex gap-1.5 overflow-x-auto px-4 pb-2">
          {data.thumbnails.map((thumbnail, index) => (
            <button
              key={`${data.createdAt}-${index}`}
              type="button"
              onClick={() => setZoomed(thumbnail)}
              className="relative shrink-0 cursor-zoom-in overflow-hidden rounded-lg border transition-transform hover:scale-[1.03]"
              style={{ borderColor: COLORS.border }}
              title={`第 ${index + 1} 屏（点击放大）`}
            >
              <img
                src={
                  thumbnail.startsWith("data:") ? thumbnail : `data:image/jpeg;base64,${thumbnail}`
                }
                alt={`第 ${index + 1} 屏截图`}
                className="h-[64px] w-[102px] object-cover object-top"
              />
              <span
                className="absolute bottom-0.5 right-0.5 rounded px-1 text-[10px]"
                style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}
              >
                {index + 1}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="px-4 pb-3">
        <pre
          className="rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed whitespace-pre-wrap font-sans"
          style={{
            background: "var(--glass)",
            borderColor: COLORS.border,
            color: COLORS.textMuted,
          }}
        >
          {data.content}
        </pre>
        {data.url ? (
          <p className="mt-1.5 truncate text-[10px]" style={{ color: COLORS.textSubtle }}>
            审查页面：{data.url}
          </p>
        ) : null}
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
