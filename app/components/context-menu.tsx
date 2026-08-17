// 模块说明：通用右键菜单（跟随鼠标定位，点击外部 / Esc / 滚动自动关闭）。
"use client";

import { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
}

export function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 只在点击菜单外部时关闭；点击菜单内部必须留给 onClick 处理，
    // 否则 mousedown 先卸载菜单会导致菜单项 click 永远不触发。
    const handlePointerDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  // 限制在视口内，避免菜单被裁掉
  const left = Math.min(x, Math.max(8, window.innerWidth - 150));
  const top = Math.min(y, Math.max(8, window.innerHeight - items.length * 34 - 16));

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[99999] w-36 overflow-hidden rounded-[12px] border p-1 shadow-2xl"
      style={{
        left,
        top,
        background: "var(--glass-solid)",
        borderColor: "var(--border)",
        fontSize: "11px !important",
        backdropFilter: "blur(24px) saturate(130%)",
        WebkitBackdropFilter: "blur(24px) saturate(130%)",
      }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
          className="flex w-full cursor-pointer items-center rounded-[9px] px-2 py-1 text-left transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] disabled:cursor-default disabled:opacity-40"
          style={{ color: "var(--text-primary)", fontSize: "11px !important" }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
