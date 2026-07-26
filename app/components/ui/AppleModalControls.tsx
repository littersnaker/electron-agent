// 模块说明：统一维护弹窗中的 Apple 风格按钮、关闭按钮和开关控件。
"use client";

import type {
  ButtonHTMLAttributes,
  CSSProperties,
  ReactNode,
} from "react";

type AppleButtonVariant = "primary" | "secondary" | "ghost" | "accent";
type AppleButtonSize = "xs" | "sm" | "md";

interface AppleButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  children: ReactNode;
  variant?: AppleButtonVariant;
  size?: AppleButtonSize;
  fullWidth?: boolean;
}

interface AppleSwitchProps {
  checked: boolean;
  ariaLabel: string;
  disabled?: boolean;
  onChange: () => void;
}

const SIZE_CLASS_NAMES: Record<AppleButtonSize, string> = {
  xs: "h-7 rounded-[9px] px-2.5 text-[10px]",
  sm: "h-8 rounded-[10px] px-3 text-[11px]",
  md: "h-10 rounded-[12px] px-4 text-[12px]",
};

const VARIANT_STYLES: Record<AppleButtonVariant, CSSProperties> = {
  primary: {
    background: "linear-gradient(180deg, #2997ff 0%, #0a84ff 100%)",
    borderColor: "rgba(10,132,255,0.52)",
    color: "#ffffff",
    boxShadow:
      "0 8px 20px rgba(10,132,255,0.2), inset 0 1px 0 rgba(255,255,255,0.3)",
  },
  secondary: {
    background:
      "linear-gradient(180deg, color-mix(in srgb, var(--glass-active) 88%, white 12%), var(--glass))",
    borderColor: "var(--border)",
    color: "var(--text-primary)",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.24)",
  },
  ghost: {
    background: "transparent",
    borderColor: "transparent",
    color: "var(--text-secondary)",
    boxShadow: "none",
  },
  accent: {
    background: "rgba(10,132,255,0.08)",
    borderColor: "rgba(10,132,255,0.18)",
    color: "#0a84ff",
    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18)",
  },
};

export function AppleButton({
  children,
  variant = "secondary",
  size = "md",
  fullWidth = false,
  className = "",
  style,
  ...buttonProps
}: AppleButtonProps) {
  return (
    <button
      {...buttonProps}
      className={`inline-flex items-center justify-center border font-medium tracking-[-0.01em] transition-all duration-200 hover:brightness-[1.025] active:scale-[0.985] disabled:pointer-events-none disabled:opacity-40 ${SIZE_CLASS_NAMES[size]} ${fullWidth ? "w-full" : ""} ${className}`}
      style={{ ...VARIANT_STYLES[variant], ...style }}
    >
      {children}
    </button>
  );
}

export function AppleModalCloseButton({
  onClick,
  ariaLabel = "关闭弹窗",
}: {
  onClick: () => void;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={onClick}
      className="group inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-all duration-200 hover:brightness-[0.98] active:scale-[0.96]"
      style={{
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--glass-active) 86%, white 14%), var(--glass))",
        borderColor: "var(--border)",
        color: "var(--text-secondary)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.32), 0 5px 14px rgba(15,23,42,0.06)",
      }}
    >
      <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
        <path
          d="m6 6 8 8m0-8-8 8"
          stroke="currentColor"
          strokeWidth="1.65"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}

export function AppleSwitch({
  checked,
  ariaLabel,
  disabled = false,
  onChange,
}: AppleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={onChange}
      className="relative inline-flex h-[30px] w-[50px] shrink-0 rounded-full p-[2px] transition-all duration-300 active:scale-[0.98] disabled:opacity-45"
      style={{
        background: checked
          ? "linear-gradient(180deg, #39a5ff 0%, #0a84ff 100%)"
          : "rgba(120,120,128,0.2)",
        boxShadow: checked
          ? "inset 0 0 0 1px rgba(255,255,255,0.14), 0 7px 18px rgba(10,132,255,0.18)"
          : "inset 0 0 0 1px rgba(15,23,42,0.08)",
      }}
    >
      <span
        aria-hidden="true"
        className="block h-[26px] w-[26px] rounded-full transition-transform duration-300"
        style={{
          transform: checked ? "translateX(20px)" : "translateX(0)",
          background:
            "linear-gradient(180deg, rgba(255,255,255,0.99), rgba(247,247,249,0.97))",
          boxShadow:
            "0 3px 9px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.92)",
        }}
      />
    </button>
  );
}
