// src/components/chat/AssistantMessageRow.tsx
"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// 1. 强类型接口契约
interface AssistantMessageRowProps {
  content: string;
  currentTool?: string; // ⚡ 新增：当前执行的工具名
}

interface ParsedContent {
  thinking: string;
  finalText: string;
  isThinking: boolean;
}

// 2. 内部工具函数：流式核心解析器
function parseThinkingStream(content: string): ParsedContent {
  const thinkStartTag = "<think>";
  const thinkEndTag = "</think>";
  
  const startIndex = content.indexOf("<think>");
  const endIndex = content.indexOf(thinkEndTag);

  if (startIndex === -1) {
    return { thinking: "", finalText: content, isThinking: false };
  }

  if (endIndex === -1) {
    const thinking = content.substring(startIndex + thinkStartTag.length);
    return { thinking, finalText: "", isThinking: true };
  }

  const thinking = content.substring(
    startIndex + thinkStartTag.length,
    endIndex,
  );
  const finalText = content.substring(endIndex + thinkEndTag.length);
  return { thinking, finalText, isThinking: false };
}

// 3. 内部专属组件：高仿递增式脉冲骨架屏
const ThinkingSkeleton = () => {
  const [lineCount, setLineCount] = useState(1);

  useEffect(() => {
    const timer = setInterval(() => {
      setLineCount((prev) => (prev < 5 ? prev + 1 : prev));
    }, 800);
    return () => clearInterval(timer);
  }, []);

  const widths = ["w-3/4", "w-full", "w-11/12", "w-5/6", "w-2/3"];

  return (
    <div className="py-1 w-64 sm:w-80 select-none">
      <div className="flex items-center gap-2 mb-3 text-zinc-400 text-xs font-medium">
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
        </span>
        <span className="animate-pulse">AI 正在深度思考中...</span>
      </div>
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: lineCount }).map((_, i) => (
          <div
            key={i}
            className={`${widths[i % widths.length]} h-3 bg-zinc-200 rounded-md animate-pulse transition-all duration-300 ease-out`}
          />
        ))}
      </div>
    </div>
  );
};

// 4. 主导出组件
export default function AssistantMessageRow({
  content,
  currentTool,
}: AssistantMessageRowProps) {
  const [isExpanded, setIsExpanded] = useState(true);
  const { thinking, finalText, isThinking } = parseThinkingStream(content);

  if (currentTool) {
    return (
      <div className="py-2 w-72 animate-pulse font-mono select-none">
        <div className="flex items-center gap-2 text-blue-600 text-xs font-semibold mb-2">
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500" />
          </span>
          <span>SYSTEM AGENT ACTIVE</span>
        </div>
        <div className="p-2 rounded bg-zinc-950 text-emerald-400 text-xs shadow-md border border-zinc-800">
          <span className="text-zinc-500">&gt;_ langgraph_executing:</span>{" "}
          <span className="underline decoration-wavy decoration-emerald-500 font-bold">
            {currentTool}
          </span>
        </div>
      </div>
    );
  }
  // 初始全空骨架屏状态
  if (!thinking && !finalText) {
    return <ThinkingSkeleton />;
  }

  return (
    <div className="w-full flex flex-col gap-3">
      {/* 🧠 思考大纲面板 */}
      {thinking && (
        <div className="border border-zinc-100 rounded-lg bg-zinc-50 overflow-hidden shadow-[inset_0_1px_2px_rgba(0,0,0,0.02)]">
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="w-full px-3 py-2 flex items-center justify-between text-zinc-500 hover:text-zinc-800 text-xs font-medium border-b border-zinc-100 bg-zinc-50/50 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span
                className={`text-[10px] transform transition-transform ${isExpanded ? "rotate-90" : ""}`}
              >
                ▶
              </span>
              <span className="flex items-center gap-1.5">
                💡 AI 思考过程
                {isThinking && (
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
                )}
              </span>
            </div>
            <span className="text-[10px] text-zinc-400">
              {isExpanded ? "点击折叠" : "点击展开"}
            </span>
          </button>

          {isExpanded && (
            <div className="p-3 max-h-48 overflow-y-auto text-xs text-zinc-500 font-mono leading-5 break-all whitespace-pre-wrap">
              {thinking}
              {isThinking && (
                <div className="mt-2 h-2.5 bg-zinc-200 rounded animate-pulse w-1/3" />
              )}
            </div>
          )}
        </div>
      )}

      {/* 📝 Markdown 正文回答区 */}
      {(finalText.trim() || !isThinking) && (
        <div className="prose prose-sm prose-zinc max-w-none w-full overflow-x-auto wrap-break-word whitespace-normal">
          {finalText.trim() ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {finalText}
            </ReactMarkdown>
          ) : (
            <div className="space-y-2 animate-pulse py-1">
              <div className="h-3 bg-zinc-200 rounded w-1/4" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
