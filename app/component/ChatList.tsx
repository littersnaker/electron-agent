// src/app/component/ChatList.tsx
"use client";

import { useEffect, useRef } from "react";
import { Virtuoso, VirtuosoHandle } from "react-virtuoso";
import AssistantMessageRow from "./AssistantMessageRow";

type Message = {
  role: "user" | "assistant";
  content: string;
};

interface ChatListProps {
  messages: Message[];
  isStreaming: boolean;
}

export default function ChatList({ messages, isStreaming }: ChatListProps) {
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // ⚡ 引入 ref 记录首屏滚动状态，用于规避 ESLint 依赖项死循环
  const hasInitialScrolled = useRef(false);

  // ⚡ 场景 1：历史消息加载完毕的首屏“闪现吸底”
  useEffect(() => {
    if (messages.length > 0 && !hasInitialScrolled.current) {
      hasInitialScrolled.current = true; // 锁定状态，确保这辈子只进来一次
      const timer = setTimeout(() => {
        virtuosoRef.current?.scrollToIndex({
          index: messages.length - 1,
          align: "end",
          behavior: "auto",
        });
      }, 50);
      return () => clearTimeout(timer);
    }
  }, [messages]); // 🎯 填入 messages 满足 react-hooks/exhaustive-deps，通过 ref 确保业务上只执行一次

  // ⚡ 场景 2：AI 正在流式打字输出时，自动实时向下微调追随
  useEffect(() => {
    if (isStreaming && messages.length > 0) {
      virtuosoRef.current?.scrollToIndex({
        index: messages.length - 1,
        align: "end",
        behavior: "auto",
      });
    }
  }, [messages, isStreaming]);

  return (
    <div className="min-h-0 flex-1 pb-4">
      <Virtuoso
        ref={virtuosoRef}
        className="h-full w-full"
        data={messages}
        alignToBottom
        followOutput={(isAtBottom) => {
          if (isStreaming) return "auto";
          return isAtBottom ? "auto" : false;
        }}
        itemContent={(index, message) => {
          const isUser = message.role === "user";
          return (
            <div className={`flex ${isUser ? "justify-end" : "justify-start"} mb-4`}>
              <div
                className={`max-w-[85%] rounded-lg px-4 py-3 text-sm leading-6 shadow-sm 
                ${isUser ? "bg-blue-600 text-white whitespace-pre-wrap" : "bg-white text-zinc-900 border border-zinc-100"}`}
              >
                {isUser ? (
                  message.content
                ) : (
                  <AssistantMessageRow content={message.content} />
                )}
              </div>
            </div>
          );
        }}
      />
    </div>
  );
}