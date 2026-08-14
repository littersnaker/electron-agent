// 模块说明：主界面左下角设置菜单（仿 Codex 左侧栏底部入口）。
// 齿轮按钮固定在侧边栏底部，点击后向上弹出单页面入口菜单。
"use client";

import { useEffect, useRef, useState } from "react";

interface SidebarSettingsMenuProps {
  /** 打开知识库管理页的回调 */
  onOpenKnowledge: () => void;
  /** 打开 Skills 管理页的回调 */
  onOpenSkills: () => void;
  /** 打开密钥设置弹窗的回调 */
  onOpenApiKey: () => void;
}

/** 左下角设置入口按钮与弹出菜单。 */
export default function SidebarSettingsMenu({
  onOpenKnowledge,
  onOpenSkills,
  onOpenApiKey,
}: SidebarSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 点击菜单外部或按 Esc 时关闭，保证不会挡住其他面板。
  useEffect(() => {
    if (!open) return undefined;
    const handlePointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div className="relative" ref={containerRef}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="设置"
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2 text-[12px]! font-medium transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)]"
        style={{ color: "var(--text-secondary)" }}
      >
        <svg viewBox="0 0 20 20" className="h-3 w-3 shrink-0" fill="none">
          <path
            d="M10 7.2a2.8 2.8 0 1 1 0 5.6 2.8 2.8 0 0 1 0-5.6Z"
            stroke="currentColor"
            strokeWidth="1.4"
          />
          <path
            d="M8.4 2.8h3.2l.5 2 1.7.9 1.9-.7 1.6 2.8-1.3 1.6v1.7l1.3 1.6-1.6 2.8-1.9-.7-1.7.9-.5 2H8.4l-.5-2-1.7-.9-1.9.7-1.6-2.8 1.3-1.6V9.2L2.7 7.6l1.6-2.8 1.9.7 1.7-.9.5-1.8Z"
            stroke="currentColor"
            strokeWidth="1.35"
            strokeLinejoin="round"
          />
        </svg>
        设置
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-9999 mb-2 w-48 overflow-hidden rounded-[14px] border p-1 shadow-2xl text-[14px]!"
          style={{
            background: "var(--glass-solid)",
            borderColor: "var(--border)",
            backdropFilter: "blur(24px) saturate(130%)",
            WebkitBackdropFilter: "blur(24px) saturate(130%)",
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenApiKey();
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[11px] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)]"
            style={{ color: "var(--text-primary)" }}
          >
            <svg viewBox="0 0 20 20" className="h-3 w-3 shrink-0" fill="none">
              <path
                d="M8.2 12.6 4.8 16l-1-1 1.1-1.1-1.1-1.1 1-1 3.4 3.4Z"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinejoin="round"
              />
              <path
                d="M12.8 7.4c.6-.6 1.4-.9 2.3-.9s1.7.3 2.3.9-.9 1.7-.9 2.3.3 1.7.9 2.3-1.7.9-2.3.9-1.7.3-2.3.9"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </svg>
            服务与数据源
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenKnowledge();
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[11px] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)]"
            style={{ color: "var(--text-primary)" }}
          >
            <svg viewBox="0 0 20 20" className="h-3 w-3 shrink-0" fill="none">
              <path
                d="M10 5.2c-1.4-1-3-1.4-4.6-1.2v11.2c1.6-.2 3.2.2 4.6 1.2 1.4-1 3-1.4 4.6-1.2V4c-1.6-.2-3.2.2-4.6 1.2Z"
                stroke="currentColor"
                strokeWidth="1.45"
                strokeLinejoin="round"
              />
              <path d="M10 5.2v11.2" stroke="currentColor" strokeWidth="1.45" />
            </svg>
            知识库管理
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSkills();
            }}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[11px] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)]"
            style={{ color: "var(--text-primary)" }}
          >
            <svg viewBox="0 0 20 20" className="h-3 w-3 shrink-0" fill="none">
              <path
                d="M10 3.4 4 5.8v5.1c0 3 2.5 5.1 6 5.7 3.5-.6 6-2.7 6-5.7V5.8L10 3.4Z"
                stroke="currentColor"
                strokeWidth="1.45"
                strokeLinejoin="round"
              />
              <path
                d="M4.6 6.3 10 8.5l5.4-2.2M10 8.5v8"
                stroke="currentColor"
                strokeWidth="1.45"
                strokeLinecap="round"
              />
            </svg>
            Skills 管理
          </button>
        </div>
      )}
    </div>
  );
}
