import { memo } from "react";
import { useEffect, useRef } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import AssistantMessageRow from "./AssistantMessageRow";

// 暗黑主题硬编码颜色
const T = {
  surface: "#16161f",
  borderSoft: "#1f1f2e",
  fg: "#ededf2",
  accentFrom: "#a855f7",
  accentTo: "#6366f1",
  accentGlow: "rgba(139, 92, 246, 0.35)",
  accentGrad: "linear-gradient(135deg, #a855f7 0%, #6366f1 100%)",
};

// 1. 扩展 Message 类型，增加 tool_calls 字段
type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  tool_calls?: ToolCall[]; // 新增字段
};

interface ChatListProps {
  messages: Message[];
  isStreaming: boolean;
  currentTool?: string; // 新增：当前执行的工具名
}

// 为 Virtuoso 包装 memo 组件，减少不必要的重渲染
const MemoizedAssistantMessageRow = memo(AssistantMessageRow);

export default function ChatList({ messages, isStreaming, currentTool }: ChatListProps) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const hasInitialScrolled = useRef(false);

  // 自动滚动到底部的逻辑
  useEffect(() => {
    if (messages.length > 0 && virtuosoRef.current) {
      // 首次加载时延迟滚动，确保 DOM 已渲染
      if (!hasInitialScrolled.current) {
        setTimeout(() => {
          virtuosoRef.current?.scrollToIndex({
            index: messages.length - 1,
            align: "end",
            behavior: "auto",
          });
          hasInitialScrolled.current = true;
        }, 100);
      } else {
        // 后续消息更新时平滑滚动
        virtuosoRef.current?.scrollToIndex({
          index: messages.length - 1,
          align: "end",
          behavior: "smooth",
        });
      }
    }
  }, [messages.length]);

  return (
    <div className="min-h-0 flex-1 pb-4">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        alignToBottom
        followOutput={isStreaming ? "smooth" : false}
        // 扩大视口外预渲染区域（顶部和底部各 300px），减少快速滚动白屏
        increaseViewportBy={{ top: 300, bottom: 300 }}
        // 上下额外预渲染 8 行，比滚动方向更远
        overscan={8}
        itemContent={(index, message) => {
          const isUser = message.role === "user";
          const isLastMessage = index === messages.length - 1; // 判断是否是最后一条消息
          return (
            <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
              <div
                className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm ${
                  isUser ? "text-white" : ""
                }`}
                style={
                  isUser
                    ? { background: T.accentGrad, boxShadow: `0 4px 14px -4px ${T.accentGlow}` }
                    : { background: T.surface, border: `1px solid ${T.borderSoft}`, color: T.fg }
                }
              >
                {/* 如果是用户消息 */}
                {isUser && <div className="whitespace-pre-wrap break-words">{message.content}</div>}

                {/* 如果是 AI 消息 */}
                {!isUser && (
                  <>
                    {/* B. 渲染常规回复 */}
                    {message.content && (
                      <div className="whitespace-pre-wrap">
                        <MemoizedAssistantMessageRow 
                          content={message.content} 
                          currentTool={isLastMessage ? currentTool : undefined} // 仅对最后一条消息传递 currentTool
                        />
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}