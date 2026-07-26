// 模块说明：渲染 Electron 自定义窗口控制按钮，替代无法被网页弹窗覆盖的原生标题栏控件。
"use client";

import { useEffect, useState } from "react";

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
      <path
        d="M3.5 8h9"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MaximizeIcon({ maximized }: { maximized: boolean }) {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
      {maximized ? (
        <>
          <rect
            x="4.75"
            y="3.25"
            width="7.25"
            height="7.25"
            rx="1"
            stroke="currentColor"
            strokeWidth="1.1"
          />
          <path
            d="M3.75 5.5H3.5a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-.25"
            stroke="currentColor"
            strokeWidth="1.1"
            strokeLinecap="round"
          />
        </>
      ) : (
        <rect
          x="3.25"
          y="3.25"
          width="9.5"
          height="9.5"
          rx="1.2"
          stroke="currentColor"
          strokeWidth="1.15"
        />
      )}
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none">
      <path
        d="m4.5 4.5 7 7m0-7-7 7"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}

export default function WindowControls() {
  const [supported, setSupported] = useState(false);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const controls = window.electronAPI?.windowControls;
    if (!controls) return undefined;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSupported(true);
    void controls.isMaximized().then(setMaximized);
    return controls.onMaximizedChange(setMaximized);
  }, []);

  if (!supported) return null;

  const controls = window.electronAPI?.windowControls;
  if (!controls) return null;

  const commonButtonClass =
    "flex h-8 w-10 items-center justify-center transition-colors duration-150 active:bg-[var(--glass-active)]";

  return (
    <div
      className="flex h-8 overflow-hidden rounded-[11px] border"
      style={{
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--glass-active) 82%, transparent), color-mix(in srgb, var(--glass) 88%, transparent))",
        borderColor: "var(--border)",
        color: "var(--text-secondary)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.26), 0 5px 14px rgba(15,23,42,0.055)",
      }}
    >
      <button
        type="button"
        aria-label="最小化窗口"
        onClick={() => controls.minimize()}
        className={`${commonButtonClass} hover:bg-[var(--glass-hover)]`}
      >
        <MinimizeIcon />
      </button>
      <button
        type="button"
        aria-label={maximized ? "还原窗口" : "最大化窗口"}
        onClick={() => void controls.toggleMaximize()}
        className={`${commonButtonClass} border-l hover:bg-[var(--glass-hover)]`}
        style={{ borderColor: "var(--border)" }}
      >
        <MaximizeIcon maximized={maximized} />
      </button>
      <button
        type="button"
        aria-label="关闭窗口"
        onClick={() => controls.close()}
        className={`${commonButtonClass} border-l hover:bg-[#ff5f57] hover:text-white`}
        style={{ borderColor: "var(--border)" }}
      >
        <CloseIcon />
      </button>
    </div>
  );
}
