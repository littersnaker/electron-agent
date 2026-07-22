import React from "react";
import { ChatSession, WorkspaceProject } from "../const/pageConst";

interface ChatSidebarProps {
  sessions: ChatSession[];
  projects: WorkspaceProject[];
  activeSessionId: string;
  isStreaming: boolean;
  createQaSession: () => void;
  createCodeSession: (projectId: string) => void;
  addProject: () => void;
  reindexProject: (projectId: string) => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string, event: React.MouseEvent) => void;
}

const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  material: "var(--glass)",
  materialStrong: "var(--glass-hover)",
  materialHover: "var(--glass-hover)",
  border: "var(--border)",
  blue: "var(--accent-blue)",
  green: "var(--accent-green)",
  amber: "var(--accent-amber)",
  red: "var(--accent-red)",
};

function PlusIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none">
      <path
        d="M10 4v12M4 10h12"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ChatIcon() {
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

function FolderIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <path
        d="M2.8 5.8A1.8 1.8 0 0 1 4.6 4h3.1l1.45 1.65h6.25a1.8 1.8 0 0 1 1.8 1.8v6.75a1.8 1.8 0 0 1-1.8 1.8H4.6a1.8 1.8 0 0 1-1.8-1.8V5.8Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function SessionItem({
  session,
  activeSessionId,
  isStreaming,
  switchSession,
  deleteSession,
}: Pick<
  ChatSidebarProps,
  | "activeSessionId"
  | "isStreaming"
  | "switchSession"
  | "deleteSession"
> & { session: ChatSession }) {
  const active = session.id === activeSessionId;

  return (
    <button
      type="button"
      onClick={() => switchSession(session.id)}
      className="group flex w-full items-center gap-2 rounded-[11px] px-2.5 py-2 text-left transition-all duration-150"
      style={{
        color: active ? COLORS.text : COLORS.textMuted,
        background: active ? COLORS.materialHover : "transparent",
        boxShadow: active
          ? "inset 0 1px 0 rgba(255,255,255,0.035)"
          : "none",
      }}
      onMouseEnter={(event) => {
        if (!active) event.currentTarget.style.background = COLORS.material;
      }}
      onMouseLeave={(event) => {
        if (!active) event.currentTarget.style.background = "transparent";
      }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full transition-colors"
        style={{ background: active ? COLORS.blue : "rgba(255,255,255,0.18)" }}
      />
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
        {session.title}
      </span>
      <span
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          deleteSession(session.id, event as unknown as React.MouseEvent);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
            deleteSession(
              session.id,
              event as unknown as React.MouseEvent,
            );
          }
        }}
        aria-disabled={isStreaming}
        className="flex h-5 w-5 items-center justify-center rounded-full text-[13px] opacity-0 transition-all group-hover:opacity-100"
        style={{ color: COLORS.textSubtle }}
        title="删除会话"
      >
        ×
      </span>
    </button>
  );
}

function ProjectStatus({ project }: { project: WorkspaceProject }) {
  const status =
    project.indexStatus === "ready"
      ? { color: COLORS.green, text: `已索引 ${project.indexedFileCount} 个文件` }
      : project.indexStatus === "indexing"
        ? { color: COLORS.amber, text: "正在建立索引…" }
        : project.indexStatus === "error"
          ? { color: COLORS.red, text: "索引失败，可重试" }
          : { color: COLORS.textSubtle, text: "等待建立索引" };

  return (
    <div className="mt-1 flex items-center gap-1.5 px-1 text-[10px]">
      <span
        className={`h-1.5 w-1.5 rounded-full ${
          project.indexStatus === "indexing" ? "animate-pulse" : ""
        }`}
        style={{ background: status.color }}
      />
      <span className="truncate" style={{ color: COLORS.textSubtle }}>
        {status.text}
      </span>
    </div>
  );
}

export default function ChatSidebar(props: ChatSidebarProps) {
  const qaSessions = props.sessions.filter((session) => session.mode === "qa");

  return (
    <aside
      className="flex w-[282px] shrink-0 flex-col select-none border-r"
      style={{
        background: "var(--sidebar-bg)",
        borderColor: COLORS.border,
        backdropFilter: "blur(28px) saturate(135%)",
        WebkitBackdropFilter: "blur(28px) saturate(135%)",
      }}
    >
      <div className="px-4 pb-3 pt-4">
        <div className="flex items-center gap-3">
          {/* <div
            className="flex h-9 w-9 items-center justify-center rounded-[11px] border"
            style={{
              background:
                "linear-gradient(145deg, rgba(100,181,255,0.2), rgba(191,90,242,0.16))",
              borderColor: "rgba(255,255,255,0.1)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.1)",
            }}
          >
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
              <path
                d="M12 3c.62 4.36 3.02 6.76 7.38 7.38C15.02 11 12.62 13.4 12 17.76 11.38 13.4 8.98 11 4.62 10.38 8.98 9.76 11.38 7.36 12 3Z"
                fill="url(#sidebar-star)"
              />
              <defs>
                <linearGradient id="sidebar-star" x1="5" y1="4" x2="19" y2="18">
                  <stop stopColor="#64b5ff" />
                  <stop offset="1" stopColor="#bf5af2" />
                </linearGradient>
              </defs>
            </svg>
          </div> */}
          <div className="min-w-0">
            <div className="text-[14px] font-semibold tracking-[-0.01em]" style={{ color: COLORS.text }}>
              Agent Workspace
            </div>
            <div className="mt-0.5 text-[10px]" style={{ color: COLORS.textSubtle }}>
              问答与本地代码协作
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-2 px-3 pb-4">
        <button
          type="button"
          onClick={props.createQaSession}
          disabled={props.isStreaming}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-[11px] text-[12px] font-semibold text-white transition-all active:scale-[0.985] disabled:opacity-40"
          style={{
            background: "linear-gradient(180deg, var(--message-user-start) 0%, var(--message-user-end) 100%)",
            boxShadow:
              "0 8px 20px rgba(10,132,255,0.18), inset 0 1px 0 rgba(255,255,255,0.2)",
          }}
        >
          <PlusIcon />
          新建问答
        </button>
        <button
          type="button"
          onClick={props.addProject}
          disabled={props.isStreaming}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-[11px] border text-[12px] font-medium transition-all active:scale-[0.985] disabled:opacity-40"
          style={{
            background: COLORS.material,
            borderColor: COLORS.border,
            color: COLORS.textMuted,
          }}
        >
          <FolderIcon />
          添加本地项目
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-5">
        <section className="mb-5">
          <div
            className="mb-1 flex items-center gap-2 px-2 text-[10px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: COLORS.textSubtle }}
          >
            <ChatIcon />
            通用问答
          </div>
          <div className="space-y-0.5">
            {qaSessions.map((session) => (
              <SessionItem key={session.id} session={session} {...props} />
            ))}
          </div>
        </section>

        <section>
          <div
            className="mb-2 flex items-center gap-2 px-2 text-[10px] font-semibold uppercase tracking-[0.12em]"
            style={{ color: COLORS.textSubtle }}
          >
            <FolderIcon />
            项目
          </div>

          {props.projects.length === 0 && (
            <div
              className="rounded-[13px] border px-3 py-3 text-[11px] leading-5"
              style={{
                background: COLORS.material,
                borderColor: COLORS.border,
                color: COLORS.textSubtle,
              }}
            >
              添加项目后，可以使用 Code Agent、本地索引与终端工具。
            </div>
          )}

          <div className="space-y-2">
            {props.projects.map((project) => {
              const projectSessions = props.sessions.filter(
                (session) => session.projectId === project.id,
              );

              return (
                <div
                  key={project.id}
                  className="rounded-[14px] border p-2"
                  style={{
                    background: "var(--glass-soft)",
                    borderColor: COLORS.border,
                  }}
                >
                  <div className="flex items-center gap-1 px-1 py-0.5">
                    <span
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg"
                      style={{ background: COLORS.materialStrong, color: COLORS.textMuted }}
                    >
                      <FolderIcon />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div
                        className="truncate text-[12px] font-semibold"
                        title={project.rootPath}
                        style={{ color: COLORS.text }}
                      >
                        {project.name}
                      </div>
                      <ProjectStatus project={project} />
                    </div>
                    <button
                      type="button"
                      onClick={() => props.reindexProject(project.id)}
                      disabled={
                        props.isStreaming || project.indexStatus === "indexing"
                      }
                      className={`flex h-7 w-7 items-center justify-center rounded-lg text-[14px] transition-colors disabled:opacity-40 ${
                        project.indexStatus === "indexing" ? "animate-spin" : ""
                      }`}
                      style={{ color: COLORS.textSubtle }}
                      title="重建代码索引"
                    >
                      ↻
                    </button>
                    <button
                      type="button"
                      onClick={() => props.createCodeSession(project.id)}
                      disabled={props.isStreaming}
                      className="flex h-7 w-7 items-center justify-center rounded-lg transition-colors disabled:opacity-40"
                      style={{ color: COLORS.blue }}
                      title="新建 Code 会话"
                    >
                      <PlusIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {projectSessions.length > 0 && (
                    <div className="mt-1 space-y-0.5 border-t pt-1.5" style={{ borderColor: COLORS.border }}>
                      {projectSessions.map((session) => (
                        <SessionItem key={session.id} session={session} {...props} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </aside>
  );
}
