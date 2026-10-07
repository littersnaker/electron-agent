// 模块说明：Codex 风格悬浮预览窗——预览 iframe + 截图帧 + 视觉 Review，可拖动/最小化。
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../lib/api-client";
import type {
  VisualReviewFrame,
  VisualReviewController,
} from "../../hooks/useChatStream/use-visual-review";

const STATUS_LABELS: Record<string, string> = {
  idle: "待开始",
  previewStarting: "正在启动预览…",
  capturing: "正在滚动截图…",
  reviewing: "视觉模型审查中…",
  done: "Review 完成",
  error: "Review 失败",
};

const DEFAULT_POSITION = { x: 0, y: 0 }; // 0 表示用右下角默认停靠位。

interface FloatingPreviewProps {
  review: VisualReviewController;
  rootPath: string;
  visionModels: Array<{ id: string; name: string }>;
  onClose: () => void;
}

export default function FloatingPreview({
  review,
  rootPath,
  visionModels,
  onClose,
}: FloatingPreviewProps) {
  const [selectedModel, setSelectedModel] = useState("");
  const [zoomed, setZoomed] = useState<VisualReviewFrame | null>(null);
  const [minimized, setMinimized] = useState(false);
  const [position, setPosition] = useState(DEFAULT_POSITION);
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );
  const [browserEnabled, setBrowserEnabled] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void apiFetch("/api/agent/browser-settings", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((payload: { enabled?: boolean } | null) => {
        if (!cancelled && payload && typeof payload.enabled === "boolean") {
          setBrowserEnabled(payload.enabled);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const busy = review.isBusy;
  const statusLabel =
    !review.settingsEnabled || !browserEnabled
      ? "已在设置中关闭"
      : (STATUS_LABELS[review.status] ?? review.status);

  const modelOptions = useMemo(
    () => [{ id: "", name: "自动" }, ...visionModels],
    [visionModels],
  );

  const handleStart = () => {
    void review.startReview({ rootPath, modelId: selectedModel });
  };

  const handleAudit = () => {
    void review.auditSite({ rootPath, modelId: selectedModel });
  };

  const onDragStart = (event: React.PointerEvent) => {
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      baseX: position.x,
      baseY: position.y,
    };
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  };
  const onDragMove = (event: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    setPosition({
      x: drag.baseX + (event.clientX - drag.startX),
      y: drag.baseY + (event.clientY - drag.startY),
    });
  };
  const onDragEnd = () => {
    dragRef.current = null;
  };

  if (minimized) {
    return (
      <button
        type="button"
        onClick={() => setMinimized(false)}
        className="fixed bottom-5 z-40 flex h-11 w-11 cursor-pointer items-center justify-center rounded-[14px] border shadow-lg transition-transform hover:scale-105"
        style={{
          right: 24,
          background: "var(--glass-solid)",
          borderColor: "var(--accent-blue-border-strong)",
          color: "var(--accent-blue)",
          transform: `translate(${position.x}, ${position.y})`,
        }}
        title="展开页面预览"
      >
        <svg viewBox="0 0 20 20" className="h-4.5 w-4.5" fill="none">
          <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
          <path d="M3 7.5h14" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      </button>
    );
  }

  return (
    <section
      className="fixed bottom-5 z-40 flex max-h-[72vh] w-[420px] flex-col overflow-hidden rounded-[18px] border shadow-2xl"
      style={{
        right: 24,
        background: "var(--glass-solid)",
        borderColor: "var(--border-strong, var(--border))",
        backdropFilter: "blur(30px) saturate(150%)",
        WebkitBackdropFilter: "blur(30px) saturate(150%)",
        transform: `translate(${position.x}, ${position.y})`,
      }}
    >
      <header
        className="flex shrink-0 cursor-grab items-center justify-between gap-2 border-b px-3 py-2 active:cursor-grabbing"
        style={{ borderColor: "var(--border)" }}
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[8px] border text-(--accent-blue)"
            style={{ background: "var(--accent-blue-soft-strong)", borderColor: "var(--accent-blue-border)" }}
          >
            <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
              <rect x="3" y="4" width="14" height="12" rx="2" stroke="currentColor" strokeWidth="1.6" />
              <path d="M3 7.5h14" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </span>
          <span className="text-[12px] font-semibold text-(--text-primary)">页面预览</span>
          <span className="truncate text-[10px] text-(--text-tertiary)">{statusLabel}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1" onPointerDown={(e) => e.stopPropagation()}>
          <button
            type="button"
            onClick={() => setMinimized(true)}
            aria-label="最小化"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-(--text-tertiary) transition-colors hover:bg-(--glass-hover) hover:text-(--text-primary)"
          >
            <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
              <path d="M5 10h10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭预览"
            className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-(--text-tertiary) transition-colors hover:bg-(--glass-hover) hover:text-(--text-primary)"
          >
            <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
              <path d="m6 6 8 8M14 6l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-1.5 px-3 pt-2">
        <select
          value={selectedModel}
          onChange={(event) => setSelectedModel(event.target.value)}
          disabled={busy}
          aria-label="选择视觉模型"
          className="max-w-[130px] cursor-pointer truncate rounded-lg border px-2 py-1 text-[11px] outline-none"
          style={{ background: "var(--glass)", borderColor: "var(--border)", color: "var(--text-secondary)" }}
        >
          {modelOptions.map((option) => (
            <option key={option.id || "auto"} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        {review.previewUrl ? (
          <button
            type="button"
            onClick={() => void review.stopPreview()}
            className="cursor-pointer rounded-lg border px-2.5 py-1 text-[11px] transition-colors hover:opacity-80"
            style={{ background: "var(--glass)", borderColor: "var(--border)", color: "var(--text-secondary)" }}
          >
            停止
          </button>
        ) : null}
        <button
          type="button"
          onClick={handleAudit}
          disabled={busy || !rootPath || !review.canCapture || !review.settingsEnabled || !browserEnabled}
          title="自动发现同源页面并逐页截图 Review"
          className="cursor-pointer rounded-lg border px-2.5 py-1 text-[11px] transition-all hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
          style={{ background: "var(--glass)", borderColor: "var(--border)", color: "var(--text-secondary)" }}
        >
          全站巡检
        </button>
        <button
          type="button"
          onClick={handleStart}
          disabled={busy || !rootPath || !review.canCapture || !review.settingsEnabled}
          title={!review.settingsEnabled ? "视觉 Review 已在设置中关闭" : review.canCapture ? "" : "截图需要桌面应用环境"}
          className="cursor-pointer rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-all hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
          style={{
            background: "rgba(10,132,255,0.16)",
            borderColor: "var(--accent-blue-border-strong)",
            color: "var(--accent-blue)",
          }}
        >
          {busy ? "进行中…" : "截图 Review"}
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
        {review.error ? (
          <p
            className="mb-2 rounded-lg border px-2.5 py-1.5 text-[11px]"
            style={{
              background: "rgba(255,69,58,0.1)",
              borderColor: "rgba(255,69,58,0.25)",
              color: "var(--accent-red, #ff6961)",
            }}
          >
            {review.error}
          </p>
        ) : null}

        {review.previewUrl ? (
          <iframe
            src={review.previewUrl}
            title="项目预览"
            className="h-[220px] w-full rounded-xl border"
            style={{ borderColor: "var(--border)", background: "#fff" }}
          />
        ) : (
          <div
            className="flex h-[120px] items-center justify-center gap-2 rounded-xl border border-dashed text-[11px]"
            style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
          >
            {review.status === "previewStarting" ? "正在启动预览…" : rootPath ? "点击「截图 Review」启动预览并审查页面" : "先打开一个项目后可用"}
          </div>
        )}

        {review.frames.length > 0 ? (
          <div className="mt-2 flex gap-1.5 overflow-x-auto pb-1">
            {review.frames.map((frame, index) => (
              <button
                key={`${frame.offsetTop}-${index}`}
                type="button"
                onClick={() => setZoomed(frame)}
                className="relative shrink-0 cursor-pointer overflow-hidden rounded-lg border transition-transform hover:scale-[1.03]"
                style={{ borderColor: "var(--border)" }}
                title={`第 ${index + 1} 屏（点击放大）`}
              >
                <img
                  src={`data:image/jpeg;base64,${frame.base64}`}
                  alt={`第 ${index + 1} 屏截图`}
                  className="h-[64px] w-[104px] object-cover object-top"
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

        {review.reviewText ? (
          <div
            className="mt-2 rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed whitespace-pre-wrap"
            style={{ background: "var(--glass)", borderColor: "var(--border)", color: "var(--text-secondary)" }}
          >
            {review.reviewText}
          </div>
        ) : null}

        {review.auditResults.length > 0 ? (
          <div className="mt-2 flex flex-col gap-2">
            <div className="flex items-center justify-between text-[10px] text-(--text-tertiary)">
              <span>全站巡检结果</span>
              {review.auditProgress ? (
                <span>
                  {review.auditProgress.current}/{review.auditProgress.total} 页
                  {review.auditRunning ? " 审查中…" : " 完成"}
                </span>
              ) : null}
            </div>
            {review.auditResults.map((page) => (
              <div
                key={page.url}
                className="rounded-xl border px-3 py-2"
                style={{ background: "var(--glass)", borderColor: "var(--border)" }}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="truncate text-[11px] font-medium text-(--text-primary)" title={page.url}>
                    {page.path || "/"}
                  </span>
                  <span
                    className="shrink-0 text-[10px]"
                    style={{
                      color:
                        page.status === "reviewed"
                          ? "var(--accent-green)"
                          : page.status === "reviewFailed"
                            ? "var(--accent-amber)"
                            : "var(--accent-red)",
                    }}
                  >
                    {page.status === "reviewed" && "已审查"}
                    {page.status === "captured" && "待审查"}
                    {page.status === "captureFailed" && "截图失败"}
                    {page.status === "reviewFailed" && "审查失败"}
                  </span>
                </div>
                {page.content ? (
                  <p className="text-[11px] leading-relaxed whitespace-pre-wrap text-(--text-secondary)">
                    {page.content}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </div>

      {zoomed ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="截图放大查看"
          onClick={() => setZoomed(null)}
          onKeyDown={(event) => {
            if (event.key === "Escape") setZoomed(null);
          }}
          tabIndex={-1}
          className="fixed inset-0 z-200 flex cursor-zoom-out items-center justify-center p-8 outline-none"
          style={{ background: "rgba(0,0,0,0.72)" }}
        >
          <img
            src={`data:image/png;base64,${zoomed.fullBase64}`}
            alt="截图放大"
            className="max-h-full max-w-full rounded-xl border"
            style={{ borderColor: "var(--border-strong)" }}
          />
        </div>
      ) : null}
    </section>
  );
}
