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
    const close = () => onClose();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  // 限制在视口内，避免菜单被裁掉
  const left = Math.min(x, Math.max(8, window.innerWidth - 180));
  const top = Math.min(y, Math.max(8, window.innerHeight - items.length * 34 - 16));

  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-[99999] w-44 overflow-hidden rounded-[14px] border p-1 shadow-2xl"
      style={{
        left,
        top,
        background: "var(--glass-solid)",
        borderColor: "var(--border)",
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
          className="flex w-full cursor-pointer items-center rounded-[10px] px-2.5 py-1.5 text-left text-[12px] transition-colors duration-150 hover:bg-[color-mix(in_srgb,var(--text-primary)_7%,transparent)] disabled:cursor-default disabled:opacity-40"
          style={{ color: "var(--text-primary)" }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
