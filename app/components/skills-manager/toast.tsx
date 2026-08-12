"use client";
/**
 * 轻量 Toast 提示：安装/卸载结果反馈，自动消失。
 *
 * 支持 success / error 两种样式，全部使用主题 CSS 变量，
 * 深色与浅色模式自动适配。
 */
import { useEffect } from "react";

export interface ToastData {
  /** 提示类型 */
  kind: "success" | "error";
  /** 提示文案 */
  message: string;
  /** 自动消失前的毫秒数 */
  durationMs?: number;
}

interface ToastProps {
  /** 当前提示内容；为 null 时不渲染 */
  toast: ToastData | null;
  /** 提示消失后的回调 */
  onDismiss: () => void;
}

/** Toast 容器：右下角悬浮，自动计时关闭。 */
export default function Toast({ toast, onDismiss }: ToastProps) {
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(onDismiss, toast.durationMs ?? 3200);
    return () => window.clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;
  const isSuccess = toast.kind === "success";
  const accent = isSuccess ? "#30d158" : "#ff453a";

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 right-6 z-[320] flex max-w-[420px] items-start gap-2.5 rounded-[14px] border px-4 py-3"
      style={{
        background:
          "color-mix(in srgb, var(--glass-strong) 96%, transparent)",
        borderColor: isSuccess
          ? "rgba(48,209,88,0.28)"
          : "rgba(255,69,58,0.28)",
        boxShadow:
          "0 20px 60px rgba(0,0,0,0.28), inset 0 1px 0 rgba(255,255,255,0.14)",
        backdropFilter: "blur(24px) saturate(150%)",
        WebkitBackdropFilter: "blur(24px) saturate(150%)",
        animation: "skill-toast-in 0.28s var(--ease-apple)",
      }}
    >
      <span
        className="mt-[3px] h-2 w-2 shrink-0 rounded-full"
        style={{ background: accent, boxShadow: `0 0 10px ${accent}` }}
      />
      <span
        className="text-[12px] leading-5"
        style={{ color: "var(--text-primary)" }}
      >
        {toast.message}
      </span>
    </div>
  );
}
