// 模块说明：内置浏览器预览面板——iframe 实时页面 + 滚动截图缩略图 + 视觉 Review 结论。
"use client";

import { useMemo, useState } from "react";
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

interface PreviewPanelProps {
  /** 视觉 Review 编排器（来自 useChatStream）。 */
  review: VisualReviewController;
  /** 项目根目录，启动预览用；无项目时按钮置灰。 */
  rootPath: string;
  /** 用户配置的支持视觉的自定义模型（id + 名称），供下拉选择。 */
  visionModels: Array<{ id: string; name: string }>;
  className?: string;
}

/** 右侧「页面预览」卡片：与 TaskPlanningPanel 同款玻璃外壳。 */
export default function PreviewPanel({
  review,
  rootPath,
  visionModels,
  className = "",
}: PreviewPanelProps) {
  const [selectedModel, setSelectedModel] = useState("");
  const [zoomed, setZoomed] = useState<VisualReviewFrame | null>(null);
  const busy = review.isBusy;
  const statusLabel = !review.settingsEnabled
    ? "已在设置中关闭"
    : (STATUS_LABELS[review.status] ?? review.status);

  // 视觉模型选项：自动路由 + 用户勾选了 supportsVision 的自定义模型。
  const modelOptions = useMemo(
    () => [{ id: "", name: "自动（按能力路由）" }, ...visionModels],
    [visionModels],
  );

  const handleStart = () => {
    void review.startReview({ rootPath, modelId: selectedModel });
  };

  const handleAudit = () => {
    void review.auditSite({ rootPath, modelId: selectedModel });
  };

  return (
    <section
      className={`preview-panel flex shrink-0 flex-col overflow-hidden rounded-[22px] border ${className}`}
      style={{
        background: "linear-gradient(145deg, var(--glass-strong), var(--glass-soft))",
        borderColor: "var(--border)",
        boxShadow: "var(--shadow-card), inset 0 1px 0 rgba(255,255,255,0.08)",
        backdropFilter: "blur(34px) saturate(155%)",
        WebkitBackdropFilter: "blur(34px) saturate(155%)",
      }}
    >
      <header className="shrink-0 px-4 pb-3 pt-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] border"
              style={{
                background: "rgba(10,132,255,0.13)",
                borderColor: "rgba(10,132,255,0.22)",
                color: "#64b5ff",
              }}
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                <rect
                  x="3"
                  y="4"
                  width="14"
                  height="12"
                  rx="2"
                  stroke="currentColor"
                  strokeWidth="1.6"
                />
                <path d="M3 7.5h14" stroke="currentColor" strokeWidth="1.6" />
                <circle cx="5.6" cy="5.8" r="0.7" fill="currentColor" />
              </svg>
            </span>
            <div className="min-w-0">
              <h3
                className="truncate text-[14px] font-semibold"
                style={{ color: "var(--text-primary)" }}
              >
                页面预览
              </h3>
              <p className="truncate text-[11px]" style={{ color: "var(--text-tertiary)" }}>
                {statusLabel}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <select
              value={selectedModel}
              onChange={(event) => setSelectedModel(event.target.value)}
              disabled={busy}
              aria-label="选择视觉模型"
              className="max-w-[120px] cursor-pointer truncate rounded-lg border px-2 py-1 text-[11px] outline-none"
              style={{
                background: "var(--glass)",
                borderColor: "var(--border)",
                color: "var(--text-secondary)",
              }}
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
                style={{
                  background: "var(--glass)",
                  borderColor: "var(--border)",
                  color: "var(--text-secondary)",
                }}
              >
                停止
              </button>
            ) : null}
            <button
              type="button"
              onClick={handleAudit}
              disabled={busy || !rootPath || !review.canCapture || !review.settingsEnabled}
              title="自动发现同源页面并逐页截图 Review"
              className="cursor-pointer rounded-lg border px-2.5 py-1 text-[11px] transition-all hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                background: "var(--glass)",
                borderColor: "var(--border)",
                color: "var(--text-secondary)",
              }}
            >
              全站巡检
            </button>
            <button
              type="button"
              onClick={handleStart}
              disabled={busy || !rootPath || !review.canCapture || !review.settingsEnabled}
              title={
                !review.settingsEnabled
                  ? "视觉 Review 已在设置中关闭"
                  : review.canCapture
                    ? ""
                    : "截图需要桌面应用环境"
              }
              className="cursor-pointer rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-all hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                background: "rgba(10,132,255,0.16)",
                borderColor: "rgba(10,132,255,0.28)",
                color: "#64b5ff",
              }}
            >
              {busy ? "进行中…" : "截图 Review"}
            </button>
          </div>
        </div>
      </header>

      {review.error ? (
        <p
          className="mx-4 mb-2 shrink-0 rounded-lg border px-2.5 py-1.5 text-[11px]"
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
        <div className="min-h-0 shrink-0 px-4 pb-2">
          <iframe
            src={review.previewUrl}
            title="项目预览"
            className="h-[240px] w-full rounded-xl border"
            style={{ borderColor: "var(--border)", background: "#fff" }}
          />
        </div>
      ) : (
        <div
          className="mx-4 mb-2 flex h-[120px] shrink-0 items-center justify-center rounded-xl border border-dashed text-[11px]"
          style={{ borderColor: "var(--border)", color: "var(--text-tertiary)" }}
        >
          {rootPath ? "点击「截图 Review」启动预览并审查页面" : "先打开一个项目后可用"}
        </div>
      )}

      {review.frames.length > 0 ? (
        <div className="flex shrink-0 gap-1.5 overflow-x-auto px-4 pb-2">
          {review.frames.map((frame, index) => (
            <button
              key={frame.offsetTop}
              type="button"
              onClick={() => setZoomed(frame)}
              className="relative shrink-0 cursor-pointer overflow-hidden rounded-lg border transition-transform hover:scale-[1.03]"
              style={{ borderColor: "var(--border)" }}
              title={`第 ${index + 1} 屏（点击放大）`}
            >
              <img
                src={`data:image/jpeg;base64,${frame.base64}`}
                alt={`第 ${index + 1} 屏截图`}
                className="h-[72px] w-[116px] object-cover object-top"
              />
              <span
                className="absolute bottom-0.5 right-0.5 rounded px-1 text-[9px]"
                style={{ background: "rgba(0,0,0,0.55)", color: "#fff" }}
              >
                {index + 1}
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {review.reviewText ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <div
            className="rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed whitespace-pre-wrap"
            style={{
              background: "var(--glass)",
              borderColor: "var(--border)",
              color: "var(--text-secondary)",
            }}
          >
            {review.reviewText}
          </div>
          {review.reviewModel ? (
            <p className="mt-1.5 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
              审查模型：{review.reviewModel}
            </p>
          ) : null}
        </div>
      ) : null}

      {review.auditResults.length > 0 ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <div
            className="mb-1.5 flex items-center justify-between text-[10px]"
            style={{ color: "var(--text-tertiary)" }}
          >
            <span>全站巡检结果</span>
            {review.auditProgress ? (
              <span>
                {review.auditProgress.current}/{review.auditProgress.total} 页
                {review.auditRunning ? " 审查中…" : " 完成"}
              </span>
            ) : null}
          </div>
          <div className="flex flex-col gap-2">
            {review.auditResults.map((page) => (
              <div
                key={page.url}
                className="rounded-xl border px-3 py-2"
                style={{ background: "var(--glass)", borderColor: "var(--border)" }}
              >
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span
                    className="truncate text-[11px] font-medium"
                    style={{ color: "var(--text-primary)" }}
                    title={page.url}
                  >
                    {page.path || "/"}
                  </span>
                  <span className="shrink-0 text-[9px]" style={{ color: "var(--text-tertiary)" }}>
                    {page.status === "reviewed" && "✅ 已审查"}
                    {page.status === "captured" && "⏳ 待审查"}
                    {page.status === "captureFailed" && "⚠️ 截图失败"}
                    {page.status === "reviewFailed" && "⚠️ 审查失败"}
                  </span>
                </div>
                {page.captureError ? (
                  <p className="text-[10px]" style={{ color: "var(--accent-red, #ff6961)" }}>
                    {page.captureError}
                  </p>
                ) : null}
                {page.reviewError ? (
                  <p className="text-[10px]" style={{ color: "var(--accent-amber, #ffd60a)" }}>
                    {page.reviewError}
                  </p>
                ) : null}
                {page.content ? (
                  <p
                    className="text-[11px] leading-relaxed whitespace-pre-wrap"
                    style={{ color: "var(--text-secondary)" }}
                  >
                    {page.content}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {zoomed ? (
        <div
          role="presentation"
          onClick={() => setZoomed(null)}
          className="fixed inset-0 z-50 flex cursor-zoom-out items-center justify-center p-8"
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
