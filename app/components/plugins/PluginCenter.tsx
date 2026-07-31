// 模块说明：负责 PluginCenter 用户界面组件。
"use client";

import type {
  BuiltinPluginId,
  BuiltinPluginManifest,
  BuiltinPluginState,
} from "../../lib/plugins/types";
import {
  AppleModalCloseButton,
  AppleSwitch,
} from "../ui/AppleModalControls";

interface PluginCenterProps {
  open: boolean;
  plugins: readonly BuiltinPluginManifest[];
  enabled: BuiltinPluginState;
  onChange: (pluginId: BuiltinPluginId, enabled: boolean) => void;
  onClose: () => void;
}

function PluginGlyph({ pluginId }: { pluginId: BuiltinPluginId }) {
  if (pluginId === "code-agent") {
    return (
      <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
        <path
          d="M8.5 8 5 12l3.5 4M15.5 8 19 12l-3.5 4M13.5 6l-3 12"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
      <path
        d="M7 17 17 7M9 7h8v8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Apple 设置面板风格的插件中心。
 *
 * 弹窗位于纯网页层 z-[200]，可以完整覆盖自绘标题栏；不会再被 Electron 原生
 * titleBarOverlay 压住右上角区域。
 */
export default function PluginCenter({
  open,
  plugins,
  enabled,
  onChange,
  onClose,
}: PluginCenterProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-200 flex items-center justify-center px-4 py-10">
      <button
        type="button"
        aria-label="关闭插件中心"
        onClick={onClose}
        className="absolute inset-0 cursor-pointer"
        style={{
          background: "rgba(7, 8, 12, 0.34)",
          backdropFilter: "blur(20px) saturate(125%)",
          WebkitBackdropFilter: "blur(20px) saturate(125%)",
        }}
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-center-title"
        className="relative w-full max-w-145 overflow-hidden rounded-[28px] border"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--glass-solid) 98%, transparent), color-mix(in srgb, var(--glass-strong) 96%, transparent))",
          borderColor: "var(--border)",
          boxShadow:
            "0 34px 100px rgba(15,23,42,0.24), inset 0 1px 0 rgba(255,255,255,0.32)",
          backdropFilter: "blur(36px) saturate(155%)",
          WebkitBackdropFilter: "blur(36px) saturate(155%)",
        }}
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6">
          <div>
            <h2
              id="plugin-center-title"
              className="text-[18px] font-semibold tracking-tight text-(--text-primary)"
            >
              功能插件
            </h2>
            <p className="mt-1 max-w-110 text-[12px] leading-5 text-(--text-tertiary)">
              只开启会使用的 Agent。关闭后的能力不会出现在工作区入口中。
            </p>
          </div>
          <AppleModalCloseButton onClick={onClose} />
        </header>

        <div className="px-4 pb-5">
          <div
            className="overflow-hidden rounded-[20px] border"
            style={{
              background: "color-mix(in srgb, var(--glass-soft) 92%, transparent)",
              borderColor: "var(--border)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18)",
            }}
          >
            {plugins.map((plugin, index) => {
              const active = enabled[plugin.id];
              const accent =
                plugin.id === "code-agent" ? "#0a84ff" : "#5e5ce6";

              return (
                <div
                  key={plugin.id}
                  className="flex items-center gap-4 px-5 py-4"
                  style={{
                    borderTop:
                      index === 0 ? "none" : "1px solid var(--border)",
                  }}
                >
                  <div
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px]"
                    style={{
                      color: accent,
                      background: `color-mix(in srgb, ${accent} 13%, transparent)`,
                      boxShadow: "inset 0 1px 0 rgba(255,255,255,0.3)",
                    }}
                  >
                    <PluginGlyph pluginId={plugin.id} />
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-semibold tracking-[-0.015em] text-[var(--text-primary)]">
                        {plugin.name}
                      </span>
                      <span
                        className="rounded-full px-2 py-0.5 text-[9px] font-medium"
                        style={{
                          background: "var(--glass)",
                          color: "var(--text-tertiary)",
                        }}
                      >
                        内置
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-[18px] text-[var(--text-tertiary)]">
                      {plugin.description}
                    </p>
                  </div>

                  <AppleSwitch
                    checked={active}
                    ariaLabel={`${active ? "关闭" : "启用"}${plugin.name}`}
                    onChange={() => onChange(plugin.id, !active)}
                  />
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}
