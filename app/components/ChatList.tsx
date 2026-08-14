// 模块说明：负责 ChatList 用户界面组件。
"use client";

/* eslint-disable react-hooks/exhaustive-deps */
import { memo, useEffect, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import AssistantMessageRow, { type ToolActivity } from "./AssistantMessageRow";
import type { Message } from "../constants/page-constants";
import type { KnowledgeSourceItem } from "../types/workspace";
import MessageAttachmentGallery from "./MessageAttachmentGallery";
import AmazonListingCard from "./commerce/AmazonListingCard";
import CommerceReportCard from "./commerce/CommerceReportCard";

interface ChatListProps {
  messages: Message[];
  isStreaming: boolean;
  toolActivities?: ToolActivity[];
  agentStatus?: string;
  knowledgeSources?: KnowledgeSourceItem[] | null;
  knowledgeSearched?: boolean;
}

const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  material: "var(--glass)",
  border: "var(--border)",
};

const MemoizedAssistantMessageRow = memo(AssistantMessageRow);

function AssistantBadge() {
  return (
    <div
      className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-[9px] border"
      style={{
        background: "linear-gradient(145deg, var(--glass-hover), var(--glass-soft))",
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
            <stop stopColor="var(--accent-blue-hover)" />
            <stop offset="1" stopColor="#bf5af2" />
          </linearGradient>
        </defs>
      </svg>
    </div>
  );
}

function ChatList({
  messages,
  isStreaming,
  toolActivities = [],
  agentStatus,
  knowledgeSources = null,
  knowledgeSearched = false,
}: ChatListProps) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const copyResetTimerRef = useRef<number | null>(null);

  // ChatList 会由父组件使用 activeSessionId 作为 key。切换会话时组件会重新挂载，
  // 因此这里使用 Virtuoso 官方提供的 initialTopMostItemIndex 指定初始位置。
  // 仅使用 alignToBottom 只能处理“消息总高度小于视口”的短会话；长会话仍会从
  // 第一条消息开始。将最后一条消息按 end 对齐，可以在首次绘制时直接定位到最新消息，
  // 同时不会干扰用户在当前会话中主动向上滚动查看历史记录。
  const initialTopMostItemIndex =
    messages.length > 0
      ? {
          index: messages.length - 1,
          align: "end" as const,
        }
      : undefined;

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
        initialTopMostItemIndex={initialTopMostItemIndex}
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
              Boolean(message.attachments?.length) ||
              Boolean(message.commerceReport) ||
              Boolean(message.commerceListing) ||
              (isLastMessage &&
                (isStreaming || toolActivities.length > 0 || Boolean(agentStatus))));

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
                      boxShadow: "var(--message-user-shadow)",
                    }}
                  >
                    <MessageAttachmentGallery attachments={message.attachments} compact />
                    {message.content && (
                      <div className="whitespace-pre-wrap break-words">{message.content}</div>
                    )}
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
                        color: copied ? "var(--accent-green)" : "var(--text-tertiary)",
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
                          background: "color-mix(in srgb, var(--app-bg) 86%, transparent)",
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
                  {message.commerceListing
                    ? "Amazon Listing Builder"
                    : message.commerceReport
                      ? "Market Intelligence Agent"
                      : "Agent"}
                </div>
                {isLastMessage && knowledgeSearched && (
                  <div
                    className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10px]"
                    style={{ color: COLORS.textMuted }}
                  >
                    {knowledgeSources && knowledgeSources.length > 0 ? (
                      <>
                        <span
                          className="rounded-full border px-2 py-0.5 font-medium"
                          style={{
                            borderColor: COLORS.border,
                            background: "color-mix(in srgb, var(--accent-blue) 10%, transparent)",
                            color: "var(--accent-blue)",
                          }}
                        >
                          知识库命中 {knowledgeSources.length} 条
                        </span>
                        <span className="min-w-0 truncate">
                          {knowledgeSources
                            .map((item) => item.sourcePath.split("/").pop() || item.sourcePath)
                            .join("、")}
                        </span>
                      </>
                    ) : (
                      <span
                        className="rounded-full border px-2 py-0.5"
                        style={{
                          borderColor: COLORS.border,
                          color: COLORS.textMuted,
                        }}
                      >
                        未检索到相关知识库内容
                      </span>
                    )}
                  </div>
                )}
                <div
                  className="min-w-0 rounded-[18px] border px-4 py-3.5"
                  style={{
                    color: COLORS.text,
                    background: COLORS.material,
                    borderColor: COLORS.border,
                    boxShadow: "inset 0 1px 0 rgba(255,255,255,0.025)",
                  }}
                >
                  {message.commerceReport && <CommerceReportCard report={message.commerceReport} />}
                  {message.commerceListing && (
                    <AmazonListingCard report={message.commerceListing} />
                  )}
                  <MemoizedAssistantMessageRow
                    content={message.content}
                    toolActivities={isLastMessage ? toolActivities : []}
                    agentStatus={isLastMessage ? agentStatus : undefined}
                    isStreaming={isLastMessage && isStreaming}
                  />
                  <MessageAttachmentGallery attachments={message.attachments} />
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

/**
 * 缓存聊天列表，主题切换时不重新执行大型消息树和图片节点的 React 渲染。
 * 颜色仍通过 CSS 变量即时更新，因此不会影响深浅色显示。
 */
export default memo(ChatList);
