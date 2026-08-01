"use client";

import { useEffect, useRef, useState } from "react";
import type { CodeAgentExecutionMode } from "../constants/page-constants";

interface CodeAgentModeSelectorProps {
  value: CodeAgentExecutionMode;
  onChange: (value: CodeAgentExecutionMode) => void;
  disabled?: boolean;
}

const OPTIONS: ReadonlyArray<{
  value: CodeAgentExecutionMode;
  label: string;
  description: string;
}> = [
  {
    value: "suggest",
    label: "建议",
    description: "先生成文件提案，批准后再写入",
  },
  {
    value: "auto_edit",
    label: "自动编辑",
    description: "自动多轮读写文件，不执行终端命令",
  },
  {
    value: "full_auto",
    label: "全自动",
    description: "自动读写并运行受限的测试、lint、build",
  },
];

/**
 * Code Agent 执行权限选择器。
 *
 * 不使用原生 select，避免 Windows 系统菜单变成白底，并保持与模型选择器一致的
 * 深色玻璃、圆角、阴影和向上展开行为。
 */
export default function CodeAgentModeSelector({
  value,
  onChange,
  disabled = false,
}: CodeAgentModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selected = OPTIONS.find((option) => option.value === value) ?? OPTIONS[1];

  useEffect(() => {
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", closeOutside);
    document.addEventListener("keydown", closeEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      document.removeEventListener("keydown", closeEscape);
    };
  }, []);

  return (
    <div ref={rootRef} className="relative h-9 w-[124px] shrink-0">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-[11px] border px-3 text-left transition-all active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-45"
        style={{
          background: open ? "var(--glass-hover)" : "var(--glass)",
          borderColor: open ? "var(--selection-border)" : "var(--border)",
          color: "var(--text-primary)",
        }}
        title={selected.description}
        aria-label="Code Agent 执行模式"
        aria-expanded={open}
      >
        <div className="min-w-0">
          <div className="truncate text-[9px] text-[var(--text-tertiary)]">
            执行模式
          </div>
          <div className="truncate text-[11px] font-medium">{selected.label}</div>
        </div>
        <svg
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 20 20"
          style={{ color: "var(--text-tertiary)" }}
        >
          <path
            d="m5.5 7.5 4.5 4.5 4.5-4.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="1.6"
          />
        </svg>
      </button>

      {open ? (
        <div
          className="absolute bottom-full left-0 z-50 mb-2 w-[290px] overflow-hidden rounded-[16px] border p-1.5"
          style={{
            background: "var(--glass-solid)",
            borderColor: "var(--border)",
            boxShadow: "var(--shadow-card)",
            backdropFilter: "blur(32px) saturate(150%)",
          }}
        >
          {OPTIONS.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className="mb-0.5 flex w-full items-center gap-3 rounded-[10px] px-3 py-2.5 text-left transition-colors hover:bg-[var(--glass-hover)] last:mb-0"
                style={{
                  background: active ? "var(--selection-bg)" : "transparent",
                  color: active ? "var(--text-primary)" : "var(--text-secondary)",
                }}
              >
                <span
                  className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]"
                  style={{
                    borderColor: active ? "var(--selection-border)" : "var(--border)",
                    color: active ? "var(--accent-blue)" : "transparent",
                  }}
                >
                  ✓
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-semibold">{option.label}</span>
                  <span className="mt-0.5 block text-[9px] leading-4 text-[var(--text-tertiary)]">
                    {option.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
