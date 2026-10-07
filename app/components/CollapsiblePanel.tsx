// 模块说明：可折叠面板卡片——收起时只占一行标题，展开显示完整内容。
// 用于右侧信息面板：默认只露核心进度，次要信息按需展开，减少视觉噪音。
"use client";

import { useState, type ReactNode } from "react";

interface CollapsiblePanelProps {
  title: string;
  /** 标题左侧的小图标（与任务规划卡同一图标容器风格）。 */
  icon?: ReactNode;
  /** 标题右侧的轻量摘要（如计数），收起时仍然可见。 */
  hint?: ReactNode;
  /** 收起时也保留一行迷你内容（如当前状态文本），默认收起且隐藏。 */
  defaultOpen?: boolean;
  children: ReactNode;
}

export default function CollapsiblePanel({
  title,
  icon,
  hint,
  defaultOpen = false,
  children,
}: CollapsiblePanelProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section
      className="shrink-0 overflow-hidden rounded-[16px] border"
      style={{
        background: "linear-gradient(145deg, var(--glass-strong), var(--glass-soft))",
        borderColor: "var(--border)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors duration-200 hover:bg-(--glass-hover)"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          {icon && (
            <span
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border text-(--accent-blue)"
              style={{
                background: "var(--accent-blue-soft-strong)",
                borderColor: "var(--accent-blue-border)",
              }}
            >
              {icon}
            </span>
          )}
          <span className="truncate text-[12px] font-semibold tracking-[-0.01em] text-(--text-primary)">
            {title}
          </span>
          {hint !== undefined && hint !== null && (
            <span
              className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-medium text-(--accent-blue)"
              style={{ background: "var(--accent-blue-soft-strong)" }}
            >
              {hint}
            </span>
          )}
        </span>
        <svg
          viewBox="0 0 20 20"
          className="h-3.5 w-3.5 shrink-0 text-(--text-tertiary) transition-transform duration-200"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }}
          fill="none"
        >
          <path
            d="m7.5 4.5 5.5 5.5-5.5 5.5"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
      {open && <div className="px-2 pb-2.5">{children}</div>}
    </section>
  );
}
