"use client";

import type {
  BuiltinPluginId,
  BuiltinPluginManifest,
  BuiltinPluginState,
} from "../../lib/plugins/types";

interface PluginCenterProps {
  open: boolean;
  plugins: readonly BuiltinPluginManifest[];
  enabled: BuiltinPluginState;
  onChange: (pluginId: BuiltinPluginId, enabled: boolean) => void;
  onClose: () => void;
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <path
        d="m5.5 5.5 9 9m0-9-9 9"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Apple 风格的本地插件中心。
 *
 * 这里的“启用”只是打开内置能力，不会联网下载第三方代码；关闭插件后对应入口
 * 不参与首屏工作流，适合把低频 Agent 从日常 QA 启动路径中移出去。
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
    <div className="fixed inset-0 z-[90] flex items-center justify-center px-4">
      <button
        type="button"
        aria-label="关闭插件中心"
        onClick={onClose}
        className="absolute inset-0 cursor-default"
        style={{ background: "rgba(0,0,0,0.46)", backdropFilter: "blur(10px)" }}
      />

      <section
        role="dialog"
        aria-modal="true"
        aria-label="插件中心"
        className="relative w-full max-w-[560px] overflow-hidden rounded-[28px] border"
        style={{
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--glass-solid) 96%, transparent), color-mix(in srgb, var(--glass-strong) 92%, transparent))",
          borderColor: "var(--border)",
          boxShadow:
            "0 34px 90px rgba(0,0,0,0.34), inset 0 1px 0 rgba(255,255,255,0.08)",
          backdropFilter: "blur(34px) saturate(150%)",
          WebkitBackdropFilter: "blur(34px) saturate(150%)",
        }}
      >
        <header className="flex items-start justify-between gap-4 px-6 pb-4 pt-6">
          <div>
            <div className="text-[17px] font-semibold tracking-[-0.025em] text-[var(--text-primary)]">
              功能插件
            </div>
            <p className="mt-1 max-w-[430px] text-[11px] leading-5 text-[var(--text-tertiary)]">
              只开启你会使用的 Agent。关闭的能力不会出现在工作区入口中，核心问答可以保持更轻的启动路径。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors hover:bg-[var(--glass-hover)]"
            style={{ borderColor: "var(--border)", color: "var(--text-secondary)" }}
          >
            <CloseIcon />
          </button>
        </header>

        <div className="space-y-2 px-4 pb-5">
          {plugins.map((plugin) => {
            const active = enabled[plugin.id];
            const accent = "#0a84ff";

            return (
              <div
                key={plugin.id}
                className="flex items-center gap-4 rounded-[19px] border px-4 py-4"
                style={{
                  background: "var(--glass-soft)",
                  borderColor: "var(--border)",
                }}
              >
                <div
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[14px] text-[17px] font-semibold"
                  style={{
                    color: accent,
                    background: `color-mix(in srgb, ${accent} 13%, transparent)`,
                  }}
                >
                  {plugin.id === "code-agent" ? "</>" : "↗"}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-[13px] font-semibold tracking-[-0.01em] text-[var(--text-primary)]">
                      {plugin.name}
                    </span>
                    <span className="rounded-full bg-[var(--glass)] px-2 py-0.5 text-[8px] font-medium text-[var(--text-tertiary)]">
                      内置
                    </span>
                  </div>
                  <p className="mt-1 text-[10px] leading-4 text-[var(--text-tertiary)]">
                    {plugin.description}
                  </p>
                </div>

                <button
                  type="button"
                  role="switch"
                  aria-checked={active}
                  aria-label={`${active ? "关闭" : "启用"}${plugin.name}`}
                  onClick={() => onChange(plugin.id, !active)}
                  className="relative h-[30px] w-[50px] shrink-0 rounded-full p-[2px] transition-colors duration-200"
                  style={{
                    background: active ? accent : "var(--glass-strong)",
                    boxShadow: active
                      ? `0 0 0 1px color-mix(in srgb, ${accent} 32%, transparent)`
                      : "inset 0 0 0 1px var(--border)",
                  }}
                >
                  <span
                    className="block h-[26px] w-[26px] rounded-full bg-white shadow-[0_2px_8px_rgba(0,0,0,0.22)] transition-transform duration-200"
                    style={{ transform: active ? "translateX(20px)" : "translateX(0)" }}
                  />
                </button>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
