import { memo, useEffect, useRef } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import AssistantMessageRow, {
  type ToolActivity,
} from "./AssistantMessageRow";

type ToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

type Message = {
  role: "user" | "assistant";
  content: string;
  tool_calls?: ToolCall[];
};

interface ChatListProps {
  messages: Message[];
  isStreaming: boolean;
  toolActivities?: ToolActivity[];
  agentStatus?: string;
}

const COLORS = {
  text: "#f5f5f7",
  textMuted: "rgba(235, 235, 245, 0.62)",
  material: "rgba(255, 255, 255, 0.055)",
  border: "rgba(255, 255, 255, 0.085)",
  blue: "#0a84ff",
};

const MemoizedAssistantMessageRow = memo(AssistantMessageRow);

function AssistantBadge() {
  return (
    <div
      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border"
      style={{
        background:
          "linear-gradient(145deg, rgba(255,255,255,0.13), rgba(255,255,255,0.055))",
        borderColor: COLORS.border,
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.08)",
      }}
    >
      <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none">
        <path
          d="M10 2.5c.52 3.45 2.55 5.48 6 6-3.45.52-5.48 2.55-6 6-.52-3.45-2.55-5.48-6-6 3.45-.52 5.48-2.55 6-6Z"
          fill="url(#assistant-gradient)"
        />
        <defs>
          <linearGradient id="assistant-gradient" x1="4" y1="3" x2="16" y2="15">
            <stop stopColor="#64b5ff" />
            <stop offset="1" stopColor="#bf5af2" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

export default function ChatList({
  messages,
  isStreaming,
  toolActivities = [],
  agentStatus,
}: ChatListProps) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const hasInitialScrolled = useRef(false);

  useEffect(() => {
    if (!messages.length || !virtuosoRef.current) return;

    if (!hasInitialScrolled.current) {
      const timer = window.setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({
          index: messages.length - 1,
          align: "end",
          behavior: "auto",
        });
        hasInitialScrolled.current = true;
      }, 100);
      return () => window.clearTimeout(timer);
    }

    virtuosoRef.current.scrollToIndex({
      index: messages.length - 1,
      align: "end",
      behavior: "smooth",
    });
  }, [messages.length]);

  return (
    <div className="min-h-0 flex-1">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        alignToBottom
        followOutput={isStreaming ? "smooth" : false}
        increaseViewportBy={{ top: 360, bottom: 360 }}
        overscan={10}
        components={{
          Footer: () => <div className="h-5" />,
        }}
        itemContent={(index, message) => {
          const isUser = message.role === "user";
          const isLastMessage = index === messages.length - 1;
          const shouldRenderAssistant =
            !isUser &&
            (Boolean(message.content) ||
              (isLastMessage &&
                (isStreaming || toolActivities.length > 0 || Boolean(agentStatus))));

          if (isUser) {
            return (
              <div className="mb-5 flex justify-end px-1 sm:px-3">
                <div
                  className="max-w-[82%] rounded-[20px] rounded-br-[7px] px-4 py-3 text-[14px] leading-6 text-white sm:max-w-[72%]"
                  style={{
                    background:
                      "linear-gradient(180deg, #168dff 0%, #0879eb 100%)",
                    boxShadow:
                      "0 10px 28px rgba(10,132,255,0.18), inset 0 1px 0 rgba(255,255,255,0.18)",
                  }}
                >
                  <div className="whitespace-pre-wrap break-words">
                    {message.content}
                  </div>
                </div>
              </div>
            );
          }

          if (!shouldRenderAssistant) return <div className="h-1" />;

          return (
            <div className="mb-6 flex items-start gap-3 px-1 sm:px-3">
              <AssistantBadge />
              <div className="min-w-0 max-w-[calc(100%_-_40px)] flex-1 pt-0.5">
                <div
                  className="mb-1.5 text-[11px] font-medium tracking-wide"
                  style={{ color: COLORS.textMuted }}
                >
                  Agent
                </div>
                <div
                  className="min-w-0 rounded-[18px] border px-4 py-3.5"
                  style={{
                    color: COLORS.text,
                    background: COLORS.material,
                    borderColor: COLORS.border,
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.025)",
                  }}
                >
                  <MemoizedAssistantMessageRow
                    content={message.content}
                    toolActivities={isLastMessage ? toolActivities : []}
                    agentStatus={isLastMessage ? agentStatus : undefined}
                    isStreaming={isLastMessage && isStreaming}
                  />
                </div>
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}
