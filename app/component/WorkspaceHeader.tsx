"use client";

import type { ChatSession, WorkspaceProject } from "../const/pageConst";
import type { TokenInfo } from "../types/workspace";

interface WorkspaceHeaderProps {
  activeSession?: ChatSession;
  activeProject?: WorkspaceProject;
  tokenInfo: TokenInfo | null;
  isStreaming: boolean;
  onStop: () => void;
  onOpenApiKey: () => void;
}

function SessionGlyph({ mode }: { mode?: "qa" | "code" }) {
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] border"
      style={{
        background:
          mode === "code"
            ? "rgba(10,132,255,0.13)"
            : "rgba(191,90,242,0.12)",
        borderColor: "var(--border)",
        color: mode === "code" ? "#64b5ff" : "#d6a5ff",
      }}
    >
      {mode === "code" ? (
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none">
          <path
            d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none">
          <path
            d="M5.2 5h13.6A2.2 2.2 0 0 1 21 7.2v7.3a2.2 2.2 0 0 1-2.2 2.2h-7.2L7 19.3l.8-2.6H5.2A2.2 2.2 0 0 1 3 14.5V7.2A2.2 2.2 0 0 1 5.2 5Z"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </div>
  );
}

function projectStatus(project?: WorkspaceProject) {
  if (!project) {
    return {
      color: "var(--text-quaternary)",
      text: "独立问答，不读取本地项目",
      pulse: false,
    };
  }

  if (project.indexStatus === "ready") {
    return { color: "#30d158", text: `${project.name} · 本地索引已就绪`, pulse: false };
  }

  if (project.indexStatus === "error") {
    return { color: "#ff453a", text: `${project.name} · 索引异常`, pulse: false };
  }

  return { color: "#ffd60a", text: `${project.name} · 代码索引处理中`, pulse: true };
}

export default function WorkspaceHeader({
  activeSession,
  activeProject,
  tokenInfo,
  isStreaming,
  onStop,
  onOpenApiKey,
}: WorkspaceHeaderProps) {
  const status = projectStatus(activeProject);

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
        <SessionGlyph mode={activeSession?.mode} />
        <div className="min-w-0">
          <h1 className="truncate text-[15px] font-semibold tracking-[-0.015em]">
            {activeSession?.mode === "code" ? "Code Agent" : "QA Agent"}
          </h1>
          <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--text-tertiary)]">
            <span
              className={`h-1.5 w-1.5 rounded-full ${status.pulse ? "animate-pulse" : ""}`}
              style={{ background: status.color }}
            />
            <span className="truncate">{status.text}</span>
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
            title={`输入 ${tokenInfo.prompt} · 输出 ${tokenInfo.completion}`}
          >
            <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
              <path d="m11.5 2.8-6 8h4l-1 6.4 6-8h-4l1-6.4Z" fill="#ffd60a" />
            </svg>
            {tokenInfo.total}
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
            <span className="h-2.5 w-2.5 rounded-[3px] bg-current" />
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
            color: "var(--text-secondary)",
          }}
          title="API Key 设置"
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
            <path
              d="M10 6.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M16.1 11.2c.05-.39.05-.79 0-1.18l1.45-1.12-1.45-2.5-1.7.7a6.3 6.3 0 0 0-1.03-.6L13.1 4.7h-2.9l-.27 1.82c-.37.16-.71.36-1.03.6l-1.7-.7-1.45 2.5 1.45 1.12a5.8 5.8 0 0 0 0 1.18l-1.45 1.12 1.45 2.5 1.7-.7c.32.24.66.44 1.03.6l.27 1.82h2.9l.27-1.82c.37-.16.71-.36 1.03-.6l1.7.7 1.45-2.5-1.45-1.12Z"
              stroke="currentColor"
              strokeWidth="1.15"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </header>
  );
}
