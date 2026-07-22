"use client";

import { useState } from "react";
import type { FormEvent } from "react";
import type { LlmCredentials, LlmProviderId } from "../lib/llm/types";

interface Props {
  initialKeys: LlmCredentials;
  onSave: (keys: LlmCredentials) => void;
  onClose: () => void;
}

const PROVIDERS: readonly Array<{
  id: LlmProviderId;
  name: string;
  environmentKey: string;
  placeholder: string;
}> = [
  {
    id: "qwen",
    name: "Qwen / DashScope",
    environmentKey: "DASHSCOPE_API_KEY",
    placeholder: "sk-...",
  },
  {
    id: "openai",
    name: "OpenAI",
    environmentKey: "OPENAI_API_KEY",
    placeholder: "sk-...",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    environmentKey: "GEMINI_API_KEY",
    placeholder: "AIza...",
  },
];

const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  material: "var(--glass-solid)",
  materialSoft: "var(--glass)",
  border: "var(--border)",
};

export default function ApiKeyModal({ initialKeys, onSave, onClose }: Props) {
  const [keys, setKeys] = useState<LlmCredentials>(initialKeys);
  const [visibleProviders, setVisibleProviders] = useState<
    ReadonlySet<LlmProviderId>
  >(() => new Set());

  const updateKey = (provider: LlmProviderId, value: string) => {
    setKeys((current) => ({ ...current, [provider]: value }));
  };

  const toggleVisibility = (provider: LlmProviderId) => {
    setVisibleProviders((current) => {
      const next = new Set(current);
      if (next.has(provider)) next.delete(provider);
      else next.add(provider);
      return next;
    });
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSave({
      qwen: keys.qwen?.trim() || undefined,
      openai: keys.openai?.trim() || undefined,
      gemini: keys.gemini?.trim() || undefined,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      style={{
        background: "rgba(0, 0, 0, 0.36)",
        backdropFilter: "blur(20px) saturate(120%)",
        WebkitBackdropFilter: "blur(20px) saturate(120%)",
      }}
    >
      <form
        onSubmit={submit}
        className="w-[500px] max-w-full overflow-hidden rounded-[24px] border"
        style={{
          background: COLORS.material,
          borderColor: COLORS.border,
          boxShadow:
            "var(--shadow-float), inset 0 1px 0 rgba(255,255,255,0.09)",
        }}
      >
        <div className="px-6 pb-3 pt-6">
          <h2
            className="text-[19px] font-semibold tracking-[-0.02em]"
            style={{ color: COLORS.text }}
          >
            模型服务配置
          </h2>
          <p
            className="mt-2 text-[12px] leading-5"
            style={{ color: COLORS.textMuted }}
          >
            Key 仅保存在本机浏览器存储中。未填写的 Provider 可使用服务端环境变量。
          </p>
        </div>

        <div className="space-y-3 px-6 pb-5">
          {PROVIDERS.map((provider) => {
            const visible = visibleProviders.has(provider.id);
            return (
              <label key={provider.id} className="block">
                <span
                  className="mb-1.5 flex items-center justify-between text-[11px] font-medium"
                  style={{ color: COLORS.textMuted }}
                >
                  <span>{provider.name}</span>
                  <span style={{ color: COLORS.textSubtle }}>
                    {provider.environmentKey}
                  </span>
                </span>
                <div
                  className="flex h-11 items-center rounded-[12px] border px-3"
                  style={{
                    background: "var(--glass-black)",
                    borderColor: COLORS.border,
                  }}
                >
                  <input
                    type={visible ? "text" : "password"}
                    autoComplete="off"
                    className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
                    style={{ color: COLORS.text }}
                    placeholder={provider.placeholder}
                    value={keys[provider.id] || ""}
                    onChange={(event) =>
                      updateKey(provider.id, event.target.value)
                    }
                  />
                  <button
                    type="button"
                    onClick={() => toggleVisibility(provider.id)}
                    className="ml-2 rounded-lg px-2 py-1 text-[10px]"
                    style={{ color: COLORS.textSubtle }}
                  >
                    {visible ? "隐藏" : "显示"}
                  </button>
                </div>
              </label>
            );
          })}
        </div>

        <div
          className="flex gap-2 border-t px-6 py-4"
          style={{ borderColor: COLORS.border }}
        >
          <button
            type="button"
            onClick={onClose}
            className="h-10 flex-1 rounded-[12px] border text-[12px] font-medium"
            style={{
              background: COLORS.materialSoft,
              borderColor: COLORS.border,
              color: COLORS.textMuted,
            }}
          >
            取消
          </button>
          <button
            type="submit"
            className="h-10 flex-1 rounded-[12px] text-[12px] font-semibold text-white"
            style={{
              background: "linear-gradient(180deg, #168dff 0%, #0879eb 100%)",
            }}
          >
            保存配置
          </button>
        </div>
      </form>
    </div>
  );
}
