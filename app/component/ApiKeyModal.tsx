"use client";

import { FormEvent, useEffect, useState } from "react";

interface Props {
  isOpen: boolean;
  onSave: (key: string) => void;
}

const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  material: "var(--glass-solid)",
  materialSoft: "var(--glass)",
  border: "var(--border)",
  blue: "var(--accent-blue)",
};

export default function ApiKeyModal({ isOpen, onSave }: Props) {
  const [key, setKey] = useState("");
  const [showKey, setShowKey] = useState(false);

  useEffect(() => {
    const changeIsOpen = () => {
      if (isOpen) setShowKey(false);
    };
    changeIsOpen();
  }, [isOpen]);

  if (!isOpen) return null;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (key.trim()) onSave(key.trim());
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
        className="w-[420px] max-w-full overflow-hidden rounded-[24px] border"
        style={{
          background: COLORS.material,
          borderColor: COLORS.border,
          boxShadow:
            "var(--shadow-float), inset 0 1px 0 rgba(255,255,255,0.09)",
          backdropFilter: "blur(38px) saturate(150%)",
          WebkitBackdropFilter: "blur(38px) saturate(150%)",
        }}
      >
        <div className="px-6 pb-4 pt-6 text-center">
          <div
            className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-[15px] border"
            style={{
              background:
                "linear-gradient(145deg, rgba(10,132,255,0.22), rgba(191,90,242,0.16))",
              borderColor: COLORS.border,
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1)",
            }}
          >
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none">
              <path
                d="M8.2 11.5V8.7A3.8 3.8 0 0 1 12 4.9a3.8 3.8 0 0 1 3.8 3.8v2.8"
                stroke="#64b5ff"
                strokeWidth="1.8"
                strokeLinecap="round"
              />
              <rect
                x="5.6"
                y="10.5"
                width="12.8"
                height="9"
                rx="2.4"
                stroke="#64b5ff"
                strokeWidth="1.8"
              />
              <circle cx="12" cy="15" r="1.2" fill="#64b5ff" />
            </svg>
          </div>
          <h2
            className="text-[19px] font-semibold tracking-[-0.02em]"
            style={{ color: COLORS.text }}
          >
            配置千问 API Key
          </h2>
          <p
            className="mx-auto mt-2 max-w-[330px] text-[12px] leading-5"
            style={{ color: COLORS.textMuted }}
          >
            Key 仅保存在本机浏览器存储中，并随请求发送到当前模型服务。
          </p>
        </div>

        <div className="px-6 pb-6">
          <label
            htmlFor="dashscope-api-key"
            className="mb-2 block text-[11px] font-medium"
            style={{ color: COLORS.textMuted }}
          >
            API Key
          </label>
          <div
            className="flex h-11 items-center rounded-[12px] border px-3 transition-colors focus-within:border-[#0a84ff]"
            style={{
              background: "var(--glass-black)",
              borderColor: COLORS.border,
            }}
          >
            <input
              id="dashscope-api-key"
              type={showKey ? "text" : "password"}
              autoFocus
              autoComplete="off"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-[var(--text-quaternary)]"
              style={{ color: COLORS.text }}
              placeholder="sk-..."
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            <button
              type="button"
              onClick={() => setShowKey((value) => !value)}
              className="ml-2 flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-white/[0.06]"
              style={{ color: COLORS.textSubtle }}
              aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}
            >
              <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
                <path
                  d="M2.5 10s2.7-4.2 7.5-4.2 7.5 4.2 7.5 4.2-2.7 4.2-7.5 4.2S2.5 10 2.5 10Z"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
                <circle
                  cx="10"
                  cy="10"
                  r="2"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
              </svg>
            </button>
          </div>

          <button
            type="submit"
            disabled={!key.trim()}
            className="mt-4 flex h-11 w-full items-center justify-center rounded-[12px] text-[13px] font-semibold text-white transition-all active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-35"
            style={{
              background: "linear-gradient(180deg, #168dff 0%, #0879eb 100%)",
              boxShadow:
                "0 10px 24px rgba(10,132,255,0.2), inset 0 1px 0 rgba(255,255,255,0.2)",
            }}
          >
            保存并使用
          </button>

          <button
            type="button"
            onClick={() => onSave("")}
            className="mt-2 flex h-10 w-full items-center justify-center rounded-[12px] border text-[12px] font-medium transition-colors hover:bg-white/[0.055]"
            style={{
              background: COLORS.materialSoft,
              borderColor: COLORS.border,
              color: COLORS.textMuted,
            }}
          >
            使用应用内默认 Key
          </button>

          <p
            className="mt-3 text-center text-[10px]"
            style={{ color: COLORS.textSubtle }}
          >
            可以稍后在右上角的设置中重新配置
          </p>
        </div>
      </form>
    </div>
  );
}
