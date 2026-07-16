// src/app/component/ChatSidebar.tsx
import React from "react";
import { ChatSession } from "../const/pageConst";
import { T } from "../const/theme";

interface ChatSidebarProps {
  sessions: ChatSession[];
  activeSessionId: string;
  isStreaming: boolean;
  createNewSession: () => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string, e: React.MouseEvent) => void;
}

export default function ChatSidebar({
  sessions,
  activeSessionId,
  isStreaming,
  createNewSession,
  switchSession,
  deleteSession,
}: ChatSidebarProps) {
  return (
    <div
      className="w-72 flex flex-col shrink-0 select-none"
      style={{
        background: T.bgSoft,
        borderRight: `1px solid ${T.borderSoft}`,
      }}
    >
      {/* 顶部品牌区 */}
      <div className="px-5 pt-5 pb-3">
        <div className="flex items-center gap-3">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-xl text-white font-bold text-xl shrink-0"
            style={{
              background: T.accentGrad,
              boxShadow: `0 4px 14px -4px ${T.accentGlow}`,
            }}
          >
            A
          </div>
          <div className="min-w-0">
            <div className="text-base font-semibold text-gradient">
              智能助手
            </div>
            <div className="text-xs" style={{ color: T.fgSubtle }}>
              千问大模型驱动
            </div>
          </div>
        </div>
      </div>

      {/* 新增对话按钮 */}
      <div className="px-4 pb-3">
        <button
          onClick={createNewSession}
          disabled={isStreaming}
          className="btn-gradient w-full flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:transform-none disabled:shadow-none"
        >
          <span className="text-base leading-none">＋</span> 新建对话
        </button>
      </div>

      {/* 会话列表 */}
      <div className="flex-1 overflow-y-auto px-3 pb-4 space-y-1">
        <div
          className="px-2 py-1 text-xs font-medium"
          style={{ color: T.fgSubtle }}
        >
          历史对话
        </div>
        {sessions.map((session) => {
          const isActive = session.id === activeSessionId;
          return (
            <div
              key={session.id}
              onClick={() => switchSession(session.id)}
              className={`group flex items-center justify-between rounded-lg px-3 py-2.5 text-sm font-medium cursor-pointer transition-all
              ${isActive ? "" : "hover:bg-[#1d1d2a]"}`}
              style={
                isActive
                  ? {
                      background: T.surfaceHover,
                      color: T.fg,
                      boxShadow: `inset 2px 0 0 ${T.accentFrom}`,
                    }
                  : { color: T.fgMuted }
              }
            >
              <div className="flex items-center gap-2.5 truncate flex-1 mr-2">
                <span className="text-sm shrink-0 opacity-70">💬</span>
                <span className="truncate">{session.title}</span>
              </div>
              <button
                onClick={(e) => deleteSession(session.id, e)}
                disabled={isStreaming}
                className="opacity-0 group-hover:opacity-100 transition-opacity px-1 font-bold text-xs disabled:hidden hover:text-red-400"
                style={{ color: T.fgSubtle }}
                title="删除对话"
              >
                ✕
              </button>
            </div>
          );
        })}
      </div>

      {/* 底部状态栏 */}
      <div
        className="px-4 py-3 text-xs flex items-center justify-between"
        style={{
          borderTop: `1px solid ${T.borderSoft}`,
          color: T.fgSubtle,
        }}
      >
        <span>共 {sessions.length} 个对话</span>
        <span className="flex items-center gap-1.5">
          <span
            className="w-1.5 h-1.5 rounded-full"
            style={{ background: T.green }}
          ></span>
          已本地存储
        </span>
      </div>
    </div>
  );
}