"use client";

import type { ThemeMode } from "../const/theme";

interface ThemeToggleProps {
  theme: ThemeMode;
  onToggle: () => void;
  compact?: boolean;
}

export default function ThemeToggle({
  theme,
  onToggle,
  compact = false,
}: ThemeToggleProps) {
  const isLight = theme === "light";

  return (
    <button
      type="button"
      onClick={onToggle}
      className={`theme-toggle group relative flex shrink-0 items-center rounded-full border transition-all duration-300 active:scale-[0.96] ${
        compact ? "h-8 w-[58px] px-1" : "h-9 w-[66px] px-1.5"
      }`}
      style={{
        background: "var(--glass)",
        borderColor: "var(--border)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.12), var(--shadow-soft)",
      }}
      aria-label={isLight ? "切换到深色模式" : "切换到浅色模式"}
      title={isLight ? "切换到深色模式" : "切换到浅色模式"}
    >
      <span
        className={`absolute flex items-center justify-center rounded-full transition-all duration-300 ${
          compact ? "h-6 w-6" : "h-7 w-7"
        }`}
        style={{
          left: isLight ? (compact ? "29px" : "34px") : "4px",
          background: isLight
            ? "linear-gradient(145deg, #ffffff, #f1f3f7)"
            : "linear-gradient(145deg, #34343a, #1d1d21)",
          boxShadow: isLight
            ? "0 4px 12px rgba(65,72,92,0.2), inset 0 1px 0 white"
            : "0 5px 14px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.12)",
        }}
      >
        <svg
          viewBox="0 0 20 20"
          className={`transition-all duration-300 ${
            compact ? "h-3.5 w-3.5" : "h-4 w-4"
          }`}
          fill="none"
          style={{ color: isLight ? "#f5a623" : "#a9c7ff" }}
        >
          {isLight ? (
            <>
              <circle cx="10" cy="10" r="3.2" fill="currentColor" />
              <path
                d="M10 2.1v1.7M10 16.2v1.7M2.1 10h1.7M16.2 10h1.7M4.4 4.4l1.2 1.2M14.4 14.4l1.2 1.2M15.6 4.4l-1.2 1.2M5.6 14.4l-1.2 1.2"
                stroke="currentColor"
                strokeWidth="1.35"
                strokeLinecap="round"
              />
            </>
          ) : (
            <path
              d="M15.8 12.6A6.2 6.2 0 0 1 7.4 4.2 6.2 6.2 0 1 0 15.8 12.6Z"
              fill="currentColor"
            />
          )}
        </svg>
      </span>

      <span
        className="absolute left-2 text-[10px] transition-opacity duration-200"
        style={{
          color: "var(--text-tertiary)",
          opacity: isLight ? 1 : 0,
        }}
      >
        ☾
      </span>
      <span
        className="absolute right-2 text-[10px] transition-opacity duration-200"
        style={{
          color: "var(--text-tertiary)",
          opacity: isLight ? 0 : 1,
        }}
      >
        ☀
      </span>
    </button>
  );
}
