// 模块说明：负责 WorkspaceHeader 用户界面组件。
"use client";

import type {
  ChatSession,
  ComposerMode,
  SessionMode,
  WorkspaceProject,
} from "../constants/page-constants";
import type { TokenInfo } from "../types/workspace";

interface WorkspaceHeaderProps {
  activeSession?: ChatSession;
  activeProject?: WorkspaceProject;
  composerMode: ComposerMode;
  tokenInfo: TokenInfo | null;
  isStreaming: boolean;
  onStop: () => void;
  onOpenApiKey: () => void;
}

function isMediaMode(mode: ComposerMode): boolean {
  return mode !== "chat";
}

function SessionGlyph({
  sessionMode,
  composerMode,
}: {
  sessionMode?: SessionMode;
  composerMode: ComposerMode;
}) {
  const isCode = sessionMode === "code";
  const isCommerce = sessionMode === "commerce";
  const isMedia = sessionMode === "qa" && isMediaMode(composerMode);

  const background = isCode
    ? "var(--accent-blue-soft-strong)"
    : isCommerce
      ? "var(--accent-blue-soft-strong)"
      : isMedia
        ? "rgba(191,90,242,0.14)"
        : "rgba(191,90,242,0.12)";
  const color = isCode
    ? "var(--accent-blue-hover)"
    : isCommerce
      ? "var(--accent-blue-hover)"
      : isMedia
        ? "#bf5af2"
        : "#d6a5ff";

  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border"
      style={{ background, borderColor: "var(--border)", color }}
    >
      {isCode ? (
        "</>"
      ) : isCommerce ? (
        <svg viewBox="0 0 20 20" className="h-[18px] w-[18px]" fill="none">
          <path
            d="M3.5 15.2h13M4.8 13V9.5M8.2 13V6.8M11.7 13V9.8M15.1 13V4.5"
            stroke="currentColor"
            strokeWidth="1.55"
            strokeLinecap="round"
          />
        </svg>
      ) : isMedia ? (
        "✦"
      ) : (
        "◎"
      )}
    </div>
  );
}

function resolveHeaderText(
  activeSession: ChatSession | undefined,
  activeProject: WorkspaceProject | undefined,
  composerMode: ComposerMode,
): { title: string; subtitle: string } {
  if (activeSession?.mode === "code") {
    return {
      title: "Code Agent",
      subtitle: activeProject
        ? `${activeProject.name} · ${activeProject.indexStatus === "ready" ? "本地索引已就绪" : "代码索引处理中"}`
        : "当前未绑定本地项目",
    };
  }

  if (activeSession?.mode === "commerce") {
    return {
      title: "Commerce Agent",
      subtitle: "市场研究 · Amazon Listing Demo · 多来源数据",
    };
  }

  if (isMediaMode(composerMode)) {
    return {
      title: "Media Agent",
      subtitle: "图片生成 · 图片编辑 · 视频生成 · 视频编辑",
    };
  }

  return {
    title: "QA Agent",
    subtitle: "独立问答，不读取本地项目",
  };
}

function usageLabel(tokenInfo: TokenInfo): string {
  if (tokenInfo.unit && tokenInfo.unit !== "tokens") {
    return `${tokenInfo.label || "媒体额度"} ${tokenInfo.total}`;
  }
  return `Tokens ${tokenInfo.total}`;
}

function usageTitle(tokenInfo: TokenInfo): string {
  const auxiliary = tokenInfo.auxiliaryTotal
    ? ` · ${tokenInfo.auxiliaryLabel || "辅助 Tokens"} ${tokenInfo.auxiliaryTotal}`
    : "";

  if (tokenInfo.unit && tokenInfo.unit !== "tokens") {
    return `${tokenInfo.label || "媒体额度"}：本次消耗 ${tokenInfo.total}${auxiliary}`;
  }
  return `输入 ${tokenInfo.prompt} · 输出 ${tokenInfo.completion} · 合计 ${tokenInfo.total}${auxiliary}`;
}

export default function WorkspaceHeader({
  activeSession,
  activeProject,
  composerMode,
  tokenInfo,
  isStreaming,
  onStop,
  onOpenApiKey,
}: WorkspaceHeaderProps) {
  const header = resolveHeaderText(activeSession, activeProject, composerMode);

  return (
    <header
      className="mb-3 flex h-[58px] shrink-0 items-center justify-between rounded-[18px] border px-4"
      style={{
        background: "var(--glass)",
        borderColor: "var(--border)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.03)",
        backdropFilter: "blur(24px) saturate(130%)",
        WebkitBackdropFilter: "blur(24px) saturate(130%)",
      }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <SessionGlyph
          sessionMode={activeSession?.mode}
          composerMode={composerMode}
        />
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold tracking-[-0.015em]">
            {header.title}
          </h1>
          <div className="mt-0.5 truncate text-[10px] text-[var(--text-tertiary)]">
            {header.subtitle}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {tokenInfo && (
          <span
            className="hidden h-8 items-center gap-1.5 rounded-[10px] border px-2.5 font-mono text-[10px] tabular-nums sm:flex"
            style={{
              background: "var(--glass)",
              borderColor: "var(--border)",
              color: "var(--text-tertiary)",
            }}
            title={usageTitle(tokenInfo)}
          >
            <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
              <path d="m11.5 2.8-6 8h4l-1 6.4 6-8h-4l1-6.4Z" fill="#ffd60a" />
            </svg>
            {usageLabel(tokenInfo)}
            {Boolean(tokenInfo.auxiliaryTotal) && (
              <span className="text-[9px] text-[var(--text-quaternary)]">
                +{tokenInfo.auxiliaryTotal}T
              </span>
            )}
          </span>
        )}

        {isStreaming && (
          <button
            type="button"
            onClick={onStop}
            className="flex h-8 items-center gap-1.5 rounded-[10px] border px-2.5 text-[11px] font-medium transition-colors hover:bg-[var(--glass-hover)]"
            style={{
              background: "rgba(255,69,58,0.08)",
              borderColor: "rgba(255,69,58,0.16)",
              color: "#ff6961",
            }}
          >
            <span className="h-2.5 w-2.5 rounded-[2px] bg-current" />
            停止
          </button>
        )}

        <button
          type="button"
          onClick={onOpenApiKey}
          className="flex h-8 w-8 items-center justify-center rounded-[10px] border transition-colors hover:bg-[var(--glass-hover)]"
          style={{
            background: "var(--glass)",
            borderColor: "var(--border)",
            color: "var(--text-tertiary)",
          }}
          title="服务与数据源"
          aria-label="打开服务与数据源设置"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
            <circle cx="7" cy="10" r="3.1" stroke="currentColor" strokeWidth="1.45" />
            <path d="M10 10h6.7M14.3 10v2M16.4 10v1.2" stroke="currentColor" strokeWidth="1.45" strokeLinecap="round" />
          </svg>
        </button>
      </div>
    </header>
  );
}
