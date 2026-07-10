// src/components/chat/AssistantMessageRow.tsx
"use client";

import { useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// 暗黑主题硬编码颜色
const T = {
  bg: "#0a0a0f",
  bgSoft: "#12121a",
  surface: "#16161f",
  surfaceHover: "#1d1d2a",
  border: "#26263a",
  borderSoft: "#1f1f2e",
  fg: "#ededf2",
  fgMuted: "#9a9ab0",
  fgSubtle: "#6b6b85",
  accentFrom: "#a855f7",
  accent: "#8b5cf6",
  amber: "#f59e0b",
  green: "#22c55e",
};

// 1. 强类型接口契约
interface AssistantMessageRowProps {
  content: string;
  currentTool?: string; // 新增：当前执行的工具名
}

interface ParsedContent {
  thinking: string;
  finalText: string;
  isThinking: boolean;
}

// 2. 内部工具函数：流式核心解析器（使用不可见于自然语言的内部标签，避免与模型输出冲突）
const THINK_START = "<INTERNAL_THINK_START>";
const THINK_END = "<INTERNAL_THINK_END>";

function parseThinkingStream(content: string): ParsedContent {
  const startIndex = content.indexOf(THINK_START);
  const endIndex = content.indexOf(THINK_END);

  if (startIndex === -1) {
    return { thinking: "", finalText: content, isThinking: false };
  }

  if (endIndex === -1) {
    const thinking = content.substring(startIndex + THINK_START.length);
    return { thinking, finalText: "", isThinking: true };
  }

  const thinking = content.substring(
    startIndex + THINK_START.length,
    endIndex,
  );
  const finalText = content.substring(endIndex + THINK_END.length);
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
      <div className="flex items-center gap-2 mb-3 text-xs font-medium" style={{ color: T.fgMuted }}>
        <span className="relative flex h-2 w-2">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: T.accentFrom }} />
          <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: T.accent }} />
        </span>
        <span className="animate-pulse">AI 正在深度思考中...</span>
      </div>
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: lineCount }).map((_, i) => (
          <div
            key={i}
            className={`${widths[i % widths.length]} h-3 rounded-md animate-pulse transition-all duration-300 ease-out`}
            style={{ background: T.surfaceHover }}
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
  

  // 兜底：如果 content 已经有实际文本（不是空且不是纯工具占位符），优先显示文本内容
  // 只有当 content 真正为空时，才显示工具状态
  if (currentTool && !content.trim()) {
    return (
      <div className="py-2 w-72 animate-pulse font-mono select-none">
        <div className="flex items-center gap-2 text-xs font-semibold mb-2" style={{ color: T.accentFrom }}>
          <span className="flex h-2 w-2 relative">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ background: T.accentFrom }} />
            <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: T.accent }} />
          </span>
          <span>智能体执行中</span>
        </div>
        <div className="p-2 rounded-lg text-xs shadow-md" style={{ background: T.bg, border: `1px solid ${T.border}`, color: T.green }}>
          <span style={{ color: T.fgSubtle }}>&gt;_ 正在调用:</span>{" "}
          <span className="underline decoration-wavy font-bold" style={{ textDecorationColor: T.green }}>
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
      {/* 思考大纲面板 */}
      {thinking && (
        <div className="rounded-lg overflow-hidden" style={{ border: `1px solid ${T.borderSoft}`, background: T.bgSoft }}>
          <button
            type="button"
            onClick={() => setIsExpanded(!isExpanded)}
            className="w-full px-3 py-2 flex items-center justify-between text-xs font-medium transition-colors"
            style={{ color: T.fgMuted, borderBottom: isExpanded ? `1px solid ${T.borderSoft}` : "none", background: T.surface }}
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
                  <span className="inline-block w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: T.amber }} />
                )}
              </span>
            </div>
            <span className="text-[10px]" style={{ color: T.fgSubtle }}>
              {isExpanded ? "点击折叠" : "点击展开"}
            </span>
          </button>

          {isExpanded && (
            <div className="p-3 max-h-48 overflow-y-auto text-xs font-mono leading-5 break-all whitespace-pre-wrap" style={{ color: T.fgMuted }}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                disallowedElements={["script", "iframe", "object", "embed", "form", "input", "style"]}
                unwrapDisallowed
              >
                {thinking}
              </ReactMarkdown>
              {isThinking && (
                <div className="mt-2 h-2.5 rounded animate-pulse w-1/3" style={{ background: T.surfaceHover }} />
              )}
            </div>
          )}
        </div>
      )}

      {/* Markdown 正文回答区 */}
      {(finalText.trim() || !isThinking) && (
        <div className="prose prose-sm max-w-none w-full overflow-x-auto wrap-break-word whitespace-normal">
          {finalText.trim() ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              disallowedElements={["script", "iframe", "object", "embed", "form", "input", "style"]}
              unwrapDisallowed
            >
              {finalText}
            </ReactMarkdown>
          ) : (
            <div className="space-y-2 animate-pulse py-1">
              <div className="h-3 rounded w-1/4" style={{ background: T.surfaceHover }} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
