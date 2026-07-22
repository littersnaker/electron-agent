/* eslint-disable react-hooks/exhaustive-deps */
import { memo, useEffect, useRef, useState } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import AssistantMessageRow, { type ToolActivity } from "./AssistantMessageRow";

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
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  material: "var(--glass)",
  border: "var(--border)",
  blue: "var(--accent-blue)",
};

const MemoizedAssistantMessageRow = memo(AssistantMessageRow);

function AssistantBadge() {
  return (
    <div
      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border"
      style={{
        background:
          "linear-gradient(145deg, var(--glass-hover), var(--glass-soft))",
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
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(
    null,
  );
  const copyResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fallbackCopyText = (text: string) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand("copy");
    document.body.removeChild(textarea);
  };

  const copyUserMessage = async (content: string, index: number) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(content);
      } else {
        fallbackCopyText(content);
      }

      setCopiedMessageIndex(index);

      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current);
      }

      copyResetTimerRef.current = window.setTimeout(() => {
        setCopiedMessageIndex(null);
        copyResetTimerRef.current = null;
      }, 1600);
    } catch {
      try {
        fallbackCopyText(content);
        setCopiedMessageIndex(index);
      } catch {
        setCopiedMessageIndex(null);
      }
    }
  };

  useEffect(
    () => () => {
      if (copyResetTimerRef.current) {
        window.clearTimeout(copyResetTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!virtuosoRef.current) return;

    if (isStreaming) {
      virtuosoRef.current.scrollToIndex({
        index: messages.length - 1,
        align: "end",
        behavior: "smooth",
      });
    }
  }, [messages.length, messages[messages.length - 1]?.content, isStreaming]);

  return (
    <div className="min-h-0 flex-1">
      <Virtuoso
        ref={virtuosoRef}
        data={messages}
        alignToBottom
        followOutput="smooth"
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
                (isStreaming ||
                  toolActivities.length > 0 ||
                  Boolean(agentStatus))));

          if (isUser) {
            const copied = copiedMessageIndex === index;

            return (
              <div className="group mb-5 flex justify-end px-1 sm:px-3">
                <div className="flex max-w-[82%] flex-col items-end sm:max-w-[72%]">
                  <div
                    className="w-fit max-w-full rounded-[20px] rounded-br-[7px] px-4 py-3 text-[14px] font-normal leading-6 tracking-[-0.006em] text-white"
                    style={{
                      background:
                        "linear-gradient(180deg, var(--message-user-start) 0%, var(--message-user-end) 100%)",
                      boxShadow:
                        "0 10px 28px rgba(10,132,255,0.18), inset 0 1px 0 rgba(255,255,255,0.18)",
                    }}
                  >
                    <div className="whitespace-pre-wrap break-words">
                      {message.content}
                    </div>
                  </div>

                  <div className="mt-1 flex h-7 items-center justify-end pr-0.5">
                    <button
                      type="button"
                      onClick={() => void copyUserMessage(message.content, index)}
                      className="message-copy-button relative flex h-7 w-7 items-center justify-center rounded-[9px] border border-transparent opacity-100 outline-none transition-[opacity,transform,background-color,border-color,box-shadow] duration-200 ease-out hover:-translate-y-px hover:border-[var(--border)] hover:bg-[var(--glass-hover)] hover:shadow-[0_5px_16px_rgba(0,0,0,0.10),inset_0_1px_0_rgba(255,255,255,0.10)] active:translate-y-0 active:scale-[0.94] focus-visible:border-[var(--border-strong)] focus-visible:bg-[var(--glass-hover)] focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--accent-blue)_24%,transparent)] sm:pointer-events-none sm:translate-y-[2px] sm:opacity-0 sm:group-focus-within:pointer-events-auto sm:group-focus-within:translate-y-0 sm:group-focus-within:opacity-100 sm:group-hover:pointer-events-auto sm:group-hover:translate-y-0 sm:group-hover:opacity-100"
                      style={{
                        background: copied
                          ? "color-mix(in srgb, var(--accent-green) 12%, transparent)"
                          : "transparent",
                        borderColor: copied
                          ? "color-mix(in srgb, var(--accent-green) 25%, transparent)"
                          : undefined,
                        color: copied
                          ? "var(--accent-green)"
                          : "var(--text-tertiary)",
                        backdropFilter: "blur(18px) saturate(140%)",
                        WebkitBackdropFilter: "blur(18px) saturate(140%)",
                      }}
                      aria-label={copied ? "消息已复制" : "复制这条消息"}
                    >
                      {copied ? (
                        <svg
                          viewBox="0 0 20 20"
                          className="h-[14px] w-[14px]"
                          fill="none"
                          aria-hidden="true"
                        >
                          <path
                            d="m4.35 10.15 3.2 3.2 8.1-8.1"
                            stroke="currentColor"
                            strokeWidth="1.75"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      ) : (
                        <svg
                          viewBox="0 0 20 20"
                          className="h-[14px] w-[14px]"
                          fill="none"
                          aria-hidden="true"
                        >
                          <rect
                            x="6.25"
                            y="5.75"
                            width="8.75"
                            height="8.75"
                            rx="2.05"
                            stroke="currentColor"
                            strokeWidth="1.3"
                          />
                          <path
                            d="M5.15 12.15H4.8a2 2 0 0 1-2-2V4.8a2 2 0 0 1 2-2h5.35a2 2 0 0 1 2 2v.35"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinecap="round"
                          />
                        </svg>
                      )}

                      <span
                        className="message-copy-tooltip pointer-events-none absolute bottom-[calc(100%+7px)] right-0 z-20 whitespace-nowrap rounded-[7px] border px-2 py-1 text-[10px] font-medium leading-none tracking-[-0.01em]"
                        style={{
                          background:
                            "color-mix(in srgb, var(--app-bg) 86%, transparent)",
                          borderColor: "var(--border)",
                          color: "var(--text-secondary)",
                          boxShadow:
                            "0 8px 24px rgba(0,0,0,0.16), inset 0 1px 0 rgba(255,255,255,0.08)",
                          backdropFilter: "blur(18px) saturate(145%)",
                          WebkitBackdropFilter: "blur(18px) saturate(145%)",
                        }}
                      >
                        {copied ? "已复制" : "复制"}
                      </span>
                    </button>
                  </div>
                </div>
              </div>
            );
          }

          if (!shouldRenderAssistant) return <div className="h-1" />;

          return (
            <div className="mb-6 flex items-start gap-3 px-1 sm:px-3">
              <AssistantBadge />
              <div className="min-w-0 max-w-[calc(100%-40px)] flex-1 pt-0.5">
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
        computeItemKey={(index, item) => `${item.role}-${index}`}
      />

      <style jsx global>{`
        .message-copy-tooltip {
          opacity: 0;
          transform: translateY(3px) scale(0.98);
          transform-origin: right bottom;
          transition:
            opacity 140ms ease,
            transform 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }

        .message-copy-button:hover .message-copy-tooltip,
        .message-copy-button:focus-visible .message-copy-tooltip {
          opacity: 1;
          transform: translateY(0) scale(1);
        }

        @media (hover: none) {
          .message-copy-tooltip {
            display: none;
          }
        }
      `}</style>
    </div>
  );
}
