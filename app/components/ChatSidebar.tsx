// 模块说明：负责 ChatSidebar 用户界面组件。
import type { MouseEvent } from "react";
import type { ChatSession, WorkspaceProject } from "../constants/page-constants";
interface ChatSidebarProps {
  sessions: ChatSession[];
  projects: WorkspaceProject[];
  activeSessionId: string;
  isStreaming: boolean;
  createQaSession: () => void;
  createCommerceSession: () => void;
  createMediaSession: () => void;
  createCodeSession: (projectId: string) => void;
  addProject: () => void;
  codePluginEnabled: boolean;
  commercePluginEnabled: boolean;
  mediaPluginEnabled: boolean;
  onOpenPluginCenter: () => void;
  reindexProject: (projectId: string) => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string, event: MouseEvent) => void;
}
const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  material: "var(--glass)",
  materialStrong: "var(--glass-hover)",
  selection: "var(--selection-bg-strong)",
  selectionText: "var(--selection-text)",
  selectionIndicator: "var(--selection-indicator)",
  selectionShadow: "var(--selection-shadow)",
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

function PluginIcon() {
  return (
    <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
      <path
        d="M7.3 3.2h5.4v2.1a2.1 2.1 0 1 0 0 4.2v2.1h2.1a2.1 2.1 0 1 1 0 4.2H9.5v-2.1a2.1 2.1 0 1 0-4.2 0v2.1H3.2V9.5h2.1a2.1 2.1 0 1 0 0-4.2h2V3.2Z"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CommerceIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={className} fill="none">
      <path
        d="M3.4 15.4h13.2M4.7 13.4V9.7M8.2 13.4V6.9M11.8 13.4V10M15.3 13.4V4.6"
        stroke="currentColor"
        strokeWidth="1.55"
        strokeLinecap="round"
      />
      <path
        d="m4.6 7.1 3.2-2.2 3.2 2 4.4-3.2"
        stroke="currentColor"
        strokeWidth="1.35"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity=".9"
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
      className="group flex w-full items-center gap-2 rounded-[11px] px-2.5 py-2 text-left transition-all duration-150 cursor-pointer"
      style={{
        color: active ? COLORS.selectionText : COLORS.textMuted,
        background: active ? COLORS.selection : "transparent",
        boxShadow: active ? COLORS.selectionShadow : "none",
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
        style={{
          background: active
            ? COLORS.selectionIndicator
            : "rgba(255,255,255,0.18)",
        }}
      />
      <span className="min-w-0 flex-1 truncate text-[12px] font-medium">
        {session.title}
      </span>
      <span
        role="button"
        tabIndex={0}
        onClick={(event) => {
          event.stopPropagation();
          deleteSession(session.id, event as unknown as MouseEvent);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.stopPropagation();
            deleteSession(session.id, event as unknown as MouseEvent);
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

/**
 * 核心 QA 始终保留在侧边栏；Code 与 Commerce 仅在对应内置插件启用后展示。
 * 插件关闭时不渲染入口，避免把低频能力继续堆进 QA / 媒体模式列表。
 */
export default function ChatSidebar(props: ChatSidebarProps) {
  const qaSessions = props.sessions.filter((session) => session.mode === "qa");
  const commerceSessions = props.sessions.filter(
    (session) => session.mode === "commerce",
  );
  const mediaSessions = props.sessions.filter(
    (session) => session.mode === "media",
  );

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
        <div className="min-w-0">
          <div
            className="text-[14px] font-semibold tracking-[-0.01em]"
            style={{ color: COLORS.text }}
          >
            Multi-agent
          </div>
          <div className="mt-0.5 text-[10px]" style={{ color: COLORS.textSubtle }}>
            核心问答 · Agent 按需加载
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
            background:
              "linear-gradient(180deg, var(--message-user-start) 0%, var(--message-user-end) 100%)",
            boxShadow: "var(--primary-button-shadow)",
          }}
        >
          <PlusIcon />
          新建问答
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={props.onOpenPluginCenter}
            disabled={props.isStreaming}
            className="flex h-9 items-center justify-center gap-2 rounded-[11px] border text-[11px] font-medium transition-all active:scale-[0.985] disabled:opacity-40 cursor-pointer"
            style={{
              background: COLORS.material,
              borderColor: COLORS.border,
              color: COLORS.textMuted,
            }}
          >
            <PluginIcon />
            功能插件
          </button>
          <button
            type="button"
            onClick={props.addProject}
            disabled={props.isStreaming || !props.codePluginEnabled}
            className="flex h-9 items-center justify-center gap-2 rounded-[11px] border text-[11px] font-medium transition-all active:scale-[0.985] disabled:opacity-35 cursor-pointer"
            style={{
              background: COLORS.material,
              borderColor: COLORS.border,
              color: COLORS.textMuted,
            }}
            title={props.codePluginEnabled ? "添加本地项目" : "请先在功能插件中启用 Code Agent"}
          >
            <FolderIcon />
            本地项目
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-5">
        {props.commercePluginEnabled && (
          <>
        <section className="mb-5">
          <div
            className="mb-2 flex items-center justify-between px-2"
            style={{ color: COLORS.textSubtle }}
          >
            <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em]">
              <CommerceIcon />
              Market Intelligence
            </div>
          </div>

          <button
            type="button"
            onClick={props.createCommerceSession}
            disabled={props.isStreaming}
            className="group mb-2 flex w-full items-center gap-3 rounded-[15px] border px-3 py-3 text-left transition-all active:scale-[0.99] disabled:opacity-40"
            style={{
              background:
                "linear-gradient(145deg, var(--accent-blue-soft-strong), var(--accent-blue-soft))",
              borderColor: "var(--accent-blue-border)",
              boxShadow: "inset 0 1px 0 rgba(255,255,255,0.055)",
            }}
            title="新建跨境市场情报研究"
          >
            <span
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] border"
              style={{
                background: "var(--accent-blue-soft-strong)",
                borderColor: "var(--accent-blue-border-strong)",
                color: "var(--accent-blue-hover)",
              }}
            >
              <CommerceIcon className="h-[18px] w-[18px]" />
            </span>
            <span className="min-w-0 flex-1">
              <span
                className="block text-[12px] font-semibold tracking-[-0.01em]"
                style={{ color: COLORS.text }}
              >
                跨境市场情报
              </span>
              <span
                className="mt-0.5 block truncate text-[9px]"
                style={{ color: COLORS.textSubtle }}
              >
                公开市场研究 · 竞品可见度 · 机会信号
              </span>
            </span>
            <span
              className="flex h-6 w-6 items-center justify-center rounded-full transition-transform group-hover:scale-105"
              style={{
                background: "var(--accent-blue-soft-strong)",
                color: "var(--accent-blue-hover)",
              }}
            >
              <PlusIcon className="h-3.5 w-3.5" />
            </span>
          </button>

          {commerceSessions.length > 0 && (
            <div className="space-y-0.5">
              {commerceSessions.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  activeSessionId={props.activeSessionId}
                  isStreaming={props.isStreaming}
                  switchSession={props.switchSession}
                  deleteSession={props.deleteSession}
                />
              ))}
            </div>
          )}
        </section>

          </>
        )}

        {props.mediaPluginEnabled && (
          <>
            <section className="mb-5">
              <div
                className="mb-2 flex items-center justify-between px-2"
                style={{ color: COLORS.textSubtle }}
              >
                <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em]">
                  <span>🎬</span>
                  AI 漫剧
                </div>
              </div>

              <button
                type="button"
                onClick={props.createMediaSession}
                disabled={props.isStreaming}
                className="group mb-2 flex w-full items-center gap-3 rounded-[15px] border px-3 py-3 text-left transition-all active:scale-[0.99] disabled:opacity-40"
                style={{
                  background:
                    "linear-gradient(145deg, var(--accent-blue-soft-strong), var(--accent-blue-soft))",
                  borderColor: "var(--accent-blue-border)",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.055)",
                }}
                title="新建 AI 漫剧会话"
              >
                <span
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] border text-[16px]"
                  style={{
                    background: "var(--accent-blue-soft-strong)",
                    borderColor: "var(--accent-blue-border-strong)",
                    color: "var(--accent-blue-hover)",
                  }}
                >
                  🎬
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    className="block text-[12px] font-semibold tracking-[-0.01em]"
                    style={{ color: COLORS.text }}
                  >
                    AI 漫剧工作室
                  </span>
                  <span
                    className="mt-0.5 block truncate text-[9px]"
                    style={{ color: COLORS.textSubtle }}
                  >
                    剧本 → 分镜确认 → 出图 → 视频 → 合并
                  </span>
                </span>
                <span
                  className="flex h-6 w-6 items-center justify-center rounded-full transition-transform group-hover:scale-105"
                  style={{
                    background: "var(--accent-blue-soft-strong)",
                    color: "var(--accent-blue-hover)",
                  }}
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                </span>
              </button>

              {mediaSessions.length > 0 && (
                <div className="space-y-0.5">
                  {mediaSessions.map((session) => (
                    <SessionItem
                      key={session.id}
                      session={session}
                      activeSessionId={props.activeSessionId}
                      isStreaming={props.isStreaming}
                      switchSession={props.switchSession}
                      deleteSession={props.deleteSession}
                    />
                  ))}
                </div>
              )}
            </section>
          </>
        )}

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
              <SessionItem
                key={session.id}
                session={session}
                activeSessionId={props.activeSessionId}
                isStreaming={props.isStreaming}
                switchSession={props.switchSession}
                deleteSession={props.deleteSession}
              />
            ))}
          </div>
        </section>

        {props.codePluginEnabled && (
          <>
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
                      style={{
                        background: COLORS.materialStrong,
                        color: COLORS.textMuted,
                      }}
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
                    <div
                      className="mt-1 space-y-0.5 border-t pt-1.5"
                      style={{ borderColor: COLORS.border }}
                    >
                      {projectSessions.map((session) => (
                        <SessionItem
                          key={session.id}
                          session={session}
                          activeSessionId={props.activeSessionId}
                          isStreaming={props.isStreaming}
                          switchSession={props.switchSession}
                          deleteSession={props.deleteSession}
                        />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>          </>
        )}

      </div>
    </aside>
  );
}
