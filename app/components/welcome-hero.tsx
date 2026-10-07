// 模块说明：空会话欢迎区——时段问候 + 已启用 Agent 的快捷入口，替代空白画布。
"use client";

import type { SessionMode } from "../constants/page-constants";

interface WelcomeHeroProps {
  onCreateSession: (mode: SessionMode) => void;
  codeEnabled: boolean;
  commerceEnabled: boolean;
  mediaEnabled: boolean;
  imageEnabled: boolean;
  isBusy: boolean;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return "夜深了";
  if (hour < 11) return "上午好";
  if (hour < 14) return "中午好";
  if (hour < 18) return "下午好";
  return "晚上好";
}

function SparkLogo() {
  return (
    <div
      className="flex h-12 w-12 items-center justify-center rounded-[16px] border"
      style={{
        background:
          "linear-gradient(145deg, var(--accent-blue-soft-strong), var(--accent-blue-soft))",
        borderColor: "var(--accent-blue-border)",
        boxShadow: "0 8px 24px color-mix(in srgb, var(--accent-blue) 18%, transparent)",
      }}
    >
      <svg viewBox="0 0 20 20" className="h-6 w-6" fill="none">
        <path
          d="M10 2.6c.46 3.1 2.3 4.94 5.4 5.4-3.1.46-4.94 2.3-5.4 5.4-.46-3.1-2.3-4.94-5.4-5.4C7.7 7.54 9.54 5.7 10 2.6Z"
          fill="url(#welcome-spark-gradient)"
        />
        <path
          d="M15.4 12.8c.22 1.5 1.1 2.38 2.6 2.6-1.5.22-2.38 1.1-2.6 2.6-.22-1.5-1.1-2.38-2.6-2.6 1.5-.22 2.38-1.1 2.6-2.6Z"
          fill="url(#welcome-spark-gradient)"
          opacity="0.75"
        />
        <defs>
          <linearGradient id="welcome-spark-gradient" x1="4" y1="3" x2="16" y2="16">
            <stop stopColor="var(--accent-blue)" />
            <stop offset="1" stopColor="#bf5af2" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

interface Capability {
  mode: SessionMode;
  title: string;
  description: string;
  icon: ReactNodeLike;
}

type ReactNodeLike = React.ReactNode;

function ChatGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <path
        d="M4.2 4.5h11.6A2.2 2.2 0 0 1 18 6.7v6.15a2.2 2.2 0 0 1-2.2 2.2H9l-3.7 2.1.65-2.1H4.2A2.2 2.2 0 0 1 2 12.85V6.7a2.2 2.2 0 0 1 2.2-2.2Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CodeGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <path
        d="m7 6.2-3.6 3.6L7 13.4M13 6.2l3.6 3.6-3.6 3.6"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MarketGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <path
        d="M3.4 15.4h13.2M4.7 13.4V9.7M8.2 13.4V6.9M11.8 13.4V10M15.3 13.4V4.6"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
    </svg>
  );
}

function FilmGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <rect x="2.8" y="4.2" width="14.4" height="11.6" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M2.8 7.6h14.4M7 4.2v3.4M13 4.2v3.4" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function CameraGlyph() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <path
        d="M6.8 6 8 4.2h4L13.2 6h2.4A1.8 1.8 0 0 1 17.4 7.8v6.4a1.8 1.8 0 0 1-1.8 1.8H4.4a1.8 1.8 0 0 1-1.8-1.8V7.8A1.8 1.8 0 0 1 4.4 6h2.4Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="10.8" r="2.6" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export default function WelcomeHero({
  onCreateSession,
  codeEnabled,
  commerceEnabled,
  mediaEnabled,
  imageEnabled,
  isBusy,
}: WelcomeHeroProps) {
  const capabilities: Capability[] = [
    {
      mode: "qa",
      title: "通用问答",
      description: "上传图片提问、检索知识库、直接要答案",
      icon: <ChatGlyph />,
    },
    ...(codeEnabled
      ? [
          {
            mode: "code" as const,
            title: "代码协作",
            description: "本地项目索引、修改文件、终端验证",
            icon: <CodeGlyph />,
          },
        ]
      : []),
    ...(commerceEnabled
      ? [
          {
            mode: "commerce" as const,
            title: "跨境市场情报",
            description: "公开市场研究、竞品信号、机会分析",
            icon: <MarketGlyph />,
          },
        ]
      : []),
    ...(mediaEnabled
      ? [
          {
            mode: "media" as const,
            title: "AI 漫剧",
            description: "剧本拆镜、分镜出图、图生视频成片",
            icon: <FilmGlyph />,
          },
        ]
      : []),
    ...(imageEnabled
      ? [
          {
            mode: "image" as const,
            title: "图片识别",
            description: "货架图纸识别、视觉理解、导出 Excel",
            icon: <CameraGlyph />,
          },
        ]
      : []),
  ];

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 pb-16">
      <div
        className="flex w-full max-w-[560px] flex-col items-center text-center"
        style={{ animation: "welcomeHeroEnter 420ms cubic-bezier(0.2, 0.8, 0.2, 1) both" }}
      >
        <SparkLogo />
        <h1
          className="mt-5 text-[22px] font-semibold tracking-[-0.02em]"
          style={{ color: "var(--text-primary)" }}
        >
          {greeting()}，今天要做点什么？
        </h1>
        <p
          className="mt-1.5 text-[13px] leading-5"
          style={{ color: "var(--text-secondary)" }}
        >
          选择下面的能力开始，或在输入框直接描述你的任务
        </p>

        <div className="mt-7 grid w-full grid-cols-1 gap-2.5 sm:grid-cols-2">
          {capabilities.map((capability, index) => (
            <button
              key={capability.mode}
              type="button"
              disabled={isBusy}
              onClick={() => onCreateSession(capability.mode)}
              className="group flex cursor-pointer items-start gap-3 rounded-[16px] border px-3.5 py-3 text-left transition-all duration-200 hover:-translate-y-0.5 active:scale-[0.99] disabled:opacity-40"
              style={{
                background: "linear-gradient(160deg, var(--glass-strong), var(--glass-soft))",
                borderColor: "var(--border)",
                boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1)",
                animation: `welcomeHeroEnter 420ms cubic-bezier(0.2, 0.8, 0.2, 1) ${100 + index * 60}ms both`,
              }}
            >
              <span
                className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border text-(--accent-blue)"
                style={{
                  background: "var(--accent-blue-soft-strong)",
                  borderColor: "var(--accent-blue-border)",
                }}
              >
                {capability.icon}
              </span>
              <span className="min-w-0">
                <span
                  className="block text-[13px] font-semibold tracking-[-0.01em]"
                  style={{ color: "var(--text-primary)" }}
                >
                  {capability.title}
                </span>
                <span
                  className="mt-0.5 block text-[11px] leading-4"
                  style={{ color: "var(--text-tertiary)" }}
                >
                  {capability.description}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <style>{`
        @keyframes welcomeHeroEnter {
          from { opacity: 0; transform: translateY(14px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (prefers-reduced-motion: reduce) {
          [style*="welcomeHeroEnter"] { animation: none !important; }
        }
      `}</style>
    </div>
  );
}
