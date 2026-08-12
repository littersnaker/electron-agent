"use client";
/**
 * 自定义确认弹窗：替换浏览器原生 confirm，统一 Apple 风格。
 *
 * 使用主题 CSS 变量渲染，深色/浅色模式自动适配；确认按钮支持
 * danger 红色变体（用于卸载等破坏性操作）。
 */
import { AppleButton } from "../ui/AppleModalControls";

interface ConfirmDialogProps {
  /** 弹窗标题 */
  title: string;
  /** 弹窗说明正文 */
  message: string;
  /** 确认按钮文案 */
  confirmLabel?: string;
  /** 取消按钮文案 */
  cancelLabel?: string;
  /** 确认按钮是否使用红色危险样式 */
  danger?: boolean;
  /** 点击确认后的回调 */
  onConfirm: () => void;
  /** 点击取消 / 遮罩后的回调 */
  onCancel: () => void;
}

/** 确认弹窗组件：遮罩 + 居中卡片 + 双按钮。 */
export default function ConfirmDialog({
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center px-6">
      <button
        type="button"
        aria-label="关闭确认弹窗"
        onClick={onCancel}
        className="absolute inset-0 cursor-default"
        style={{
          background: "rgba(7, 8, 12, 0.38)",
          backdropFilter: "blur(18px) saturate(125%)",
          WebkitBackdropFilter: "blur(18px) saturate(125%)",
          cursor: "pointer",
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        className="relative w-[360px] max-w-full rounded-[22px] border p-5"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--glass-solid) 98%, transparent), color-mix(in srgb, var(--glass-strong) 96%, transparent))",
          borderColor: "var(--border-strong)",
          boxShadow:
            "0 30px 90px rgba(15,23,42,0.35), inset 0 1px 0 rgba(255,255,255,0.28)",
          backdropFilter: "blur(36px) saturate(155%)",
          WebkitBackdropFilter: "blur(36px) saturate(155%)",
        }}
      >
        <h3
          id="confirm-dialog-title"
          className="text-[15px] font-semibold tracking-[-0.01em]"
          style={{ color: "var(--text-primary)" }}
        >
          {title}
        </h3>
        <p
          className="mt-2 text-[12px] leading-5"
          style={{ color: "var(--text-secondary)" }}
        >
          {message}
        </p>
        <div className="mt-5 flex justify-end gap-2.5">
          <AppleButton
            type="button"
            variant="secondary"
            size="sm"
            onClick={onCancel}
            style={{ cursor: "pointer" }}
          >
            {cancelLabel}
          </AppleButton>
          <AppleButton
            type="button"
            variant="secondary"
            size="sm"
            onClick={onConfirm}
            style={
              danger
                ? {
                    background: "rgba(255,69,58,0.12)",
                    borderColor: "rgba(255,69,58,0.28)",
                    color: "#ff453a",
                    cursor: "pointer",
                  }
                : { cursor: "pointer" }
            }
          >
            {confirmLabel}
          </AppleButton>
        </div>
      </div>
    </div>
  );
}
