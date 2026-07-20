import React from "react";
import { ChatSession, WorkspaceProject } from "../const/pageConst";
import { T } from "../const/theme";

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

function SessionItem({ session, activeSessionId, isStreaming, switchSession, deleteSession }: Pick<ChatSidebarProps, "activeSessionId" | "isStreaming" | "switchSession" | "deleteSession"> & { session: ChatSession }) {
  const active = session.id === activeSessionId;
  return (
    <div
      onClick={() => switchSession(session.id)}
      className={`group flex cursor-pointer items-center justify-between rounded-lg px-3 py-2 text-sm transition-all ${active ? "" : "hover:bg-[#1d1d2a]"}`}
      style={active ? { background: T.surfaceHover, color: T.fg, boxShadow: `inset 2px 0 0 ${T.accentFrom}` } : { color: T.fgMuted }}
    >
      <span className="min-w-0 flex-1 truncate">{session.title}</span>
      <button onClick={(event) => deleteSession(session.id, event)} disabled={isStreaming} className="px-1 text-xs font-bold opacity-0 transition-opacity group-hover:opacity-100 hover:text-red-400 disabled:hidden" style={{ color: T.fgSubtle }} title="删除会话">×</button>
    </div>
  );
}

export default function ChatSidebar(props: ChatSidebarProps) {
  const qaSessions = props.sessions.filter((session) => session.mode === "qa");
  return (
    <aside className="flex w-72 shrink-0 flex-col select-none" style={{ background: T.bgSoft, borderRight: `1px solid ${T.borderSoft}` }}>
      <div className="px-5 pb-3 pt-5">
        <div className="text-base font-semibold text-gradient">智能助手</div>
        <div className="mt-1 text-xs" style={{ color: T.fgSubtle }}>QA Agent · Code Agent</div>
      </div>

      <div className="space-y-2 px-4 pb-3">
        <button onClick={props.createQaSession} disabled={props.isStreaming} className="btn-gradient flex w-full items-center justify-center rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40">+ 新建问答</button>
        <button onClick={props.addProject} disabled={props.isStreaming} className="flex w-full items-center justify-center rounded-lg border px-4 py-2 text-sm transition-colors hover:bg-[#1d1d2a] disabled:opacity-40" style={{ borderColor: T.border, color: T.fgMuted }}>+ 添加项目</button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-4">
        <section className="mb-4">
          <div className="px-2 py-1 text-xs font-medium" style={{ color: T.fgSubtle }}>通用问答</div>
          {qaSessions.map((session) => <SessionItem key={session.id} session={session} {...props} />)}
        </section>

        <section>
          <div className="px-2 py-1 text-xs font-medium" style={{ color: T.fgSubtle }}>项目</div>
          {props.projects.length === 0 && <p className="px-2 py-2 text-xs" style={{ color: T.fgSubtle }}>添加项目后可使用 Code Agent 和本地索引。</p>}
          {props.projects.map((project) => {
            const projectSessions = props.sessions.filter((session) => session.projectId === project.id);
            return (
              <div key={project.id} className="mb-2 rounded-lg border p-2" style={{ borderColor: T.borderSoft }}>
                <div className="flex items-center gap-1 px-1">
                  <span className="min-w-0 flex-1 truncate text-sm font-medium" title={project.rootPath} style={{ color: T.fg }}>⌘ {project.name}</span>
                  <button onClick={() => props.reindexProject(project.id)} disabled={props.isStreaming || project.indexStatus === "indexing"} className="px-1 text-xs hover:text-purple-300 disabled:opacity-50" style={{ color: T.fgSubtle }} title="重建代码索引">↻</button>
                  <button onClick={() => props.createCodeSession(project.id)} disabled={props.isStreaming} className="px-1 text-sm hover:text-purple-300 disabled:opacity-50" style={{ color: T.fgSubtle }} title="新建 Code 会话">+</button>
                </div>
                <div className="px-1 pb-1 text-[10px]" style={{ color: T.fgSubtle }}>
                  {project.indexStatus === "indexing" ? "正在建立索引…" : project.indexStatus === "ready" ? `已索引 ${project.indexedFileCount} 个文件` : project.indexStatus === "error" ? "索引失败，可重试" : "等待建立索引"}
                </div>
                {projectSessions.map((session) => <SessionItem key={session.id} session={session} {...props} />)}
              </div>
            );
          })}
        </section>
      </div>
    </aside>
  );
}
