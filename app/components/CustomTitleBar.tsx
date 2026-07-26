// 模块说明：负责应用自定义标题栏；窗口按钮完全由网页层绘制，因此弹窗可正常覆盖。
"use client";

import type { CSSProperties, MouseEvent } from "react";
import type { ThemeMode } from "../constants/theme";
import ThemeToggle from "./ThemeToggle";
import WindowControls from "./WindowControls";

interface CustomTitleBarProps {
  theme: ThemeMode;
  onToggleTheme: () => void;
  runningAgentCount?: number;
}

export default function CustomTitleBar({
  theme,
  onToggleTheme,
  runningAgentCount = 0,
}: CustomTitleBarProps) {
  const toggleMaximize = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    void window.electronAPI?.windowControls?.toggleMaximize();
  };

  return (
    <div
      className="custom-title-bar relative z-40 flex h-11 w-full shrink-0 items-center justify-between border-b px-4"
      onDoubleClick={toggleMaximize}
      style={
        {
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--titlebar-bg) 97%, transparent), color-mix(in srgb, var(--titlebar-bg) 90%, transparent))",
          borderColor: "var(--border)",
          backdropFilter: "blur(30px) saturate(150%)",
          WebkitBackdropFilter: "blur(30px) saturate(150%)",
          WebkitAppRegion: "drag",
          boxShadow: "inset 0 -1px 0 rgba(255,255,255,0.04)",
        } as CSSProperties
      }
    >
      <div className="flex min-w-0 items-center gap-2.5">
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[7px] border"
          style={{
            background:
              "linear-gradient(145deg, rgba(100,181,255,0.22), rgba(191,90,242,0.17))",
            borderColor: "var(--border)",
            boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1)",
          }}
        >
          <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
            <path
              d="M10 2.8c.48 3.46 2.44 5.42 5.9 5.9-3.46.48-5.42 2.44-5.9 5.9-.48-3.46-2.44-5.42-5.9-5.9 3.46-.48 5.42-2.44 5.9-5.9Z"
              fill="url(#title-star)"
            />
            <defs>
              <linearGradient id="title-star" x1="4" y1="3" x2="16" y2="15">
                <stop stopColor="#64b5ff" />
                <stop offset="1" stopColor="#bf5af2" />
              </linearGradient>
            </defs>
          </svg>
        </span>
        <span
          className="truncate text-[12px] font-semibold tracking-[-0.01em]"
          style={{ color: "var(--text-primary)" }}
        >
          Multi-agent
        </span>
        <span
          className="rounded-full px-2 py-0.5 text-[9px] font-medium"
          style={{
            background: "var(--glass)",
            color: "var(--text-tertiary)",
          }}
        >
          Desktop
        </span>
        {runningAgentCount > 0 && (
          <span
            className="ml-1 flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-medium"
            style={{
              background: "rgba(10,132,255,0.12)",
              color: "#0a84ff",
            }}
          >
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
            {runningAgentCount} Agents
          </span>
        )}
      </div>

      <div
        className="flex items-center gap-2"
        style={{ WebkitAppRegion: "no-drag" } as CSSProperties}
      >
        <ThemeToggle theme={theme} onToggle={onToggleTheme} compact />
        <WindowControls />
      </div>
    </div>
  );
}
