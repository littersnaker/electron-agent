"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type ToolActivityStatus = "running" | "completed" | "error";

export interface ToolActivity {
  id: string;
  label: string;
  status: ToolActivityStatus;
  startedAt: number;
  endedAt?: number;
}

interface AssistantMessageRowProps {
  content: string;
  toolActivities?: ToolActivity[];
  agentStatus?: string;
  isStreaming?: boolean;
}

interface ParsedContent {
  thinking: string;
  finalText: string;
  isThinking: boolean;
}

const THINK_START = "<INTERNAL_THINK_START>";
const THINK_END = "<INTERNAL_THINK_END>";

const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  material: "var(--glass)",
  materialStrong: "var(--glass-hover)",
  border: "var(--border)",
  borderStrong: "var(--border-strong)",
  blue: "var(--accent-blue)",
  blueSoft: "rgba(10, 132, 255, 0.14)",
  green: "var(--accent-green)",
  red: "var(--accent-red)",
  amber: "var(--accent-amber)",
};

const TOOL_META: Array<{
  key: string;
  title: string;
  description: string;
}> = [
  {
    key: "search_project_index",
    title: "搜索项目索引",
    description: "定位相关文件、符号与实现",
  },
  {
    key: "search_codebase",
    title: "搜索代码库",
    description: "扫描项目中的关键字与引用",
  },
  {
    key: "read_file_from_disk",
    title: "读取文件",
    description: "获取当前文件内容与上下文",
  },
  {
    key: "list_directory",
    title: "查看目录",
    description: "检查项目结构与文件分布",
  },
  {
    key: "propose_file_change",
    title: "生成修改方案",
    description: "准备完整文件变更与待审内容",
  },
  {
    key: "get_diff",
    title: "比较代码差异",
    description: "检查原文件与候选修改的差异",
  },
  {
    key: "apply_file_change",
    title: "应用文件修改",
    description: "将确认后的代码写入项目",
  },
  {
    key: "run_terminal_command",
    title: "运行终端命令",
    description: "在项目目录中执行命令并读取输出",
  },
];

function parseThinkingStream(content: string): ParsedContent {
  const startIndex = content.indexOf(THINK_START);
  const endIndex = content.indexOf(THINK_END);

  if (startIndex === -1) {
    return { thinking: "", finalText: content, isThinking: false };
  }

  if (endIndex === -1) {
    return {
      thinking: content.substring(startIndex + THINK_START.length),
      finalText: "",
      isThinking: true,
    };
  }

  return {
    thinking: content.substring(startIndex + THINK_START.length, endIndex),
    finalText: content.substring(endIndex + THINK_END.length),
    isThinking: false,
  };
}

function sanitizeToolLabel(label: string): string {
  return label
    .replace(/[🤖🎯🔎🧠📂🧩📝🛠️🔧⚙️✅⏳🚀]/gu, "")
    .replace(/^(正在|开始|调用|执行|工具调用|智能体执行中)[:：\s-]*/i, "")
    .trim();
}

function resolveToolMeta(label: string): {
  title: string;
  description: string;
  raw: string;
} {
  const cleaned = sanitizeToolLabel(label);
  const matched = TOOL_META.find((item) =>
    cleaned.toLowerCase().includes(item.key.toLowerCase()),
  );

  if (matched) {
    return {
      title: matched.title,
      description: matched.description,
      raw: cleaned,
    };
  }

  return {
    title: cleaned || "执行工具",
    description: "Agent 正在处理当前步骤",
    raw: cleaned,
  };
}

function formatElapsed(activity: ToolActivity, now: number): string {
  const end = activity.endedAt ?? now;
  const elapsed = Math.max(0, end - activity.startedAt);
  if (elapsed < 1000) return `${elapsed} ms`;
  return `${(elapsed / 1000).toFixed(elapsed < 10_000 ? 1 : 0)} s`;
}

function StatusGlyph({ status }: { status: ToolActivityStatus }) {
  if (status === "completed") {
    return (
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full"
        style={{ background: "rgba(48, 209, 88, 0.14)", color: COLORS.green }}
      >
        <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none">
          <path
            d="m4.25 10.2 3.15 3.15 8.35-8.35"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    );
  }

  if (status === "error") {
    return (
      <span
        className="flex h-5 w-5 items-center justify-center rounded-full text-[12px] font-semibold"
        style={{ background: "rgba(255, 69, 58, 0.14)", color: COLORS.red }}
      >
        !
      </span>
    );
  }

  return (
    <span
      className="relative flex h-5 w-5 items-center justify-center rounded-full"
      style={{ background: COLORS.blueSoft }}
    >
      <span
        className="h-2.5 w-2.5 animate-spin rounded-full border-2"
        style={{
          borderColor: "rgba(10, 132, 255, 0.25)",
          borderTopColor: COLORS.blue,
        }}
      />
      <span
        className="absolute inset-0 rounded-full animate-ping"
        style={{ border: "1px solid rgba(10, 132, 255, 0.28)" }}
      />
    </span>
  );
}

function ToolActivityPanel({
  activities,
  agentStatus,
  isStreaming,
}: {
  activities: ToolActivity[];
  agentStatus?: string;
  isStreaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  // eslint-disable-next-line react-hooks/purity
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!activities.some((item) => item.status === "running")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [activities]);

  const completedCount = activities.filter(
    (activity) => activity.status === "completed",
  ).length;
  const hasRunning = activities.some(
    (activity) => activity.status === "running",
  );
  const visibleActivities = activities.slice(-8);

  return (
    <section
      className="overflow-hidden rounded-[18px] border"
      style={{
        background: "linear-gradient(180deg, var(--glass), var(--glass-soft))",
        borderColor: COLORS.border,
        boxShadow: "var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.04)",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-[var(--glass-soft)]"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px]"
            style={{
              background: hasRunning ? COLORS.blueSoft : COLORS.materialStrong,
              color: hasRunning ? COLORS.blue : COLORS.textMuted,
            }}
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none">
              <path
                d="M8 9 4 12l4 3M16 9l4 3-4 3M14 5l-4 14"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span
                className="text-[13px] font-semibold"
                style={{ color: COLORS.text }}
              >
                Agent 活动
              </span>
              {hasRunning && isStreaming ? (
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{ background: COLORS.blueSoft, color: "#64b5ff" }}
                >
                  运行中
                </span>
              ) : (
                <span
                  className="text-[10px]"
                  style={{ color: COLORS.textSubtle }}
                >
                  {completedCount}/{activities.length} 已完成
                </span>
              )}
            </div>
            <p
              className="mt-0.5 truncate text-[11px]"
              style={{ color: COLORS.textMuted }}
            >
              {agentStatus ||
                (hasRunning ? "正在执行代码任务" : "本轮工具调用已结束")}
            </p>
          </div>
        </div>

        <svg
          viewBox="0 0 20 20"
          className={`h-4 w-4 shrink-0 transition-transform duration-200 ${
            expanded ? "rotate-180" : ""
          }`}
          fill="none"
          style={{ color: COLORS.textSubtle }}
        >
          <path
            d="m5.5 7.5 4.5 4.5 4.5-4.5"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {expanded && (
        <div
          className="border-t px-3 pb-3 pt-2"
          style={{ borderColor: COLORS.border }}
        >
          {visibleActivities.map((activity, index) => {
            const meta = resolveToolMeta(activity.label);
            const running = activity.status === "running";
            const isLast = index === visibleActivities.length - 1;

            return (
              <div
                key={activity.id}
                className="activity-enter relative flex gap-3 rounded-[14px] px-2.5 py-2.5"
                style={{
                  background: running
                    ? "rgba(10, 132, 255, 0.075)"
                    : "transparent",
                  border: running
                    ? "1px solid rgba(10, 132, 255, 0.16)"
                    : "1px solid transparent",
                }}
              >
                <div className="relative flex shrink-0 flex-col items-center">
                  <StatusGlyph status={activity.status} />
                  {!isLast && (
                    <span
                      className="mt-1 w-px flex-1"
                      style={{ background: COLORS.border }}
                    />
                  )}
                </div>

                <div className="min-w-0 flex-1 pb-0.5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div
                        className="truncate text-[12px] font-medium"
                        style={{ color: running ? "#eaf5ff" : COLORS.text }}
                      >
                        {meta.title}
                      </div>
                      <div
                        className="mt-0.5 truncate text-[10px]"
                        style={{ color: COLORS.textMuted }}
                        title={meta.raw}
                      >
                        {meta.description}
                      </div>
                    </div>
                    <span
                      className="shrink-0 font-mono text-[10px] tabular-nums"
                      style={{ color: COLORS.textSubtle }}
                    >
                      {formatElapsed(activity, now)}
                    </span>
                  </div>

                  {running && (
                    <div
                      className="mt-2 h-[2px] overflow-hidden rounded-full"
                      style={{ background: "rgba(10, 132, 255, 0.12)" }}
                    >
                      <span
                        className="tool-sweep block h-full w-1/3 rounded-full"
                        style={{
                          background:
                            "linear-gradient(90deg, transparent, #64b5ff, transparent)",
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <style>{`
        @keyframes toolSweep {
          0% {
            transform: translateX(-160%);
          }
          100% {
            transform: translateX(420%);
          }
        }
        @keyframes activityEnter {
          from {
            opacity: 0;
            transform: translateY(4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        .tool-sweep {
          animation: toolSweep 1.35s cubic-bezier(0.4, 0, 0.2, 1) infinite;
        }
        .activity-enter {
          animation: activityEnter 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
        }
      `}</style>
    </section>
  );
}

function ThinkingSkeleton({ statusText }: { statusText?: string }) {
  const [lineCount, setLineCount] = useState(2);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setLineCount((previous) => (previous < 4 ? previous + 1 : previous));
    }, 700);
    return () => window.clearInterval(timer);
  }, []);

  const widths = ["78%", "96%", "84%", "62%"];

  return (
    <div className="w-full max-w-xl select-none py-1">
      <div className="mb-3 flex items-center gap-2.5">
        <span className="relative flex h-2.5 w-2.5">
          <span
            className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-40"
            style={{ background: COLORS.blue }}
          />
          <span
            className="relative inline-flex h-2.5 w-2.5 rounded-full"
            style={{ background: COLORS.blue }}
          />
        </span>
        <span
          className="text-[12px] font-medium"
          style={{ color: COLORS.textMuted }}
        >
          {statusText || "正在分析请求…"}
        </span>
      </div>
      <div className="space-y-2.5">
        {Array.from({ length: lineCount }).map((_, index) => (
          <div
            key={index}
            className="h-2.5 animate-pulse rounded-full transition-all duration-300"
            style={{ width: widths[index], background: COLORS.materialStrong }}
          />
        ))}
      </div>
    </div>
  );
}

export default function AssistantMessageRow({
  content,
  toolActivities = [],
  agentStatus,
  isStreaming = false,
}: AssistantMessageRowProps) {
  const [isThinkingExpanded, setIsThinkingExpanded] = useState(false);
  const [userCollapsedThinking, setUserCollapsedThinking] = useState(false);

  const { thinking, finalText, isThinking } = useMemo(
    () => parseThinkingStream(content),
    [content],
  );
  useEffect(() => {
    const thinkIsClose = () => {
      // 用户自己关闭过，不再自动打开
      if (userCollapsedThinking) {
        return;
      }

      // 正在输出推理
      if (isThinking && thinking) {
        setIsThinkingExpanded(true);
      }

      // 推理结束，有正式答案
      if (!isThinking && finalText.trim()) {
        setIsThinkingExpanded(false);
      }
    };
    thinkIsClose();
  }, [isThinking, thinking, finalText, userCollapsedThinking]);

  const hasToolActivity = toolActivities.length > 0;
  const hasVisibleContent = Boolean(thinking || finalText.trim());

  if (!hasVisibleContent && !hasToolActivity) {
    return <ThinkingSkeleton statusText={agentStatus} />;
  }

  return (
    <div className="flex w-full flex-col gap-3.5 ">
      {hasToolActivity && (
        <ToolActivityPanel
          activities={toolActivities}
          agentStatus={agentStatus}
          isStreaming={isStreaming}
        />
      )}

      {thinking && (
        <section
          className="overflow-hidden rounded-2xl border transition-[max-height,opacity] duration-300"
          style={{ background: COLORS.material, borderColor: COLORS.border }}
        >
          <button
            type="button"
            onClick={() => {
              setIsThinkingExpanded((value) => !value);
              // 用户主动操作后锁定
              setUserCollapsedThinking(true);
            }}
            className="flex w-full items-center justify-between px-3.5 py-2.5 text-left transition-colors hover:bg-[var(--glass-soft)]"
          >
            <div className="flex items-center gap-2">
              <span
                className="flex h-6 w-6 items-center justify-center rounded-lg"
                style={{
                  background: COLORS.materialStrong,
                  color: COLORS.textMuted,
                }}
              >
                <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none">
                  <path
                    d="M10 3.2a5.1 5.1 0 0 0-3.15 9.1c.56.44.9 1.03.97 1.7h4.36c.07-.67.41-1.26.97-1.7A5.1 5.1 0 0 0 10 3.2Z"
                    stroke="currentColor"
                    strokeWidth="1.4"
                  />
                  <path
                    d="M8 16h4M8.7 18h2.6"
                    stroke="currentColor"
                    strokeWidth="1.4"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <span
                    className="text-[12px] font-medium"
                    style={{ color: COLORS.text }}
                  >
                    推理概要
                  </span>
                  {isThinking && (
                    <span
                      className="h-1.5 w-1.5 animate-pulse rounded-full"
                      style={{ background: COLORS.amber }}
                    />
                  )}
                </div>
                <span
                  className="text-[10px]"
                  style={{ color: COLORS.textSubtle }}
                >
                  {isThinking
                    ? "正在思考..."
                    : isThinkingExpanded
                      ? "收起详情"
                      : "查看思考过程"}
                </span>
              </div>
            </div>
            <svg
              viewBox="0 0 20 20"
              className={`h-4 w-4 transition-transform ${
                isThinkingExpanded ? "rotate-180" : ""
              }`}
              fill="none"
              style={{ color: COLORS.textSubtle }}
            >
              <path
                d="m5.5 7.5 4.5 4.5 4.5-4.5"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>

          {isThinkingExpanded && (
            <div
              className="border-t px-4 py-3 text-[12px] leading-6"
              style={{
                borderColor: COLORS.border,
                color: COLORS.textMuted,
              }}
            >
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                disallowedElements={[
                  "script",
                  "iframe",
                  "object",
                  "embed",
                  "form",
                  "input",
                  "style",
                ]}
                unwrapDisallowed
              >
                {thinking}
              </ReactMarkdown>
            </div>
          )}
        </section>
      )}

      {(finalText.trim() || (!isThinking && !hasToolActivity)) && (
        <div
          className="prose prose-sm max-w-none overflow-x-auto break-words leading-7 prose-headings:text-[var(--text-primary)] prose-strong:text-[var(--text-primary)] prose-li:text-[var(--text-primary)] prose-blockquote:text-[var(--text-secondary)] prose-blockquote:border-[var(--border-strong)]"
          style={{ color: COLORS.text }}
        >
          {finalText.trim() ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              disallowedElements={[
                "script",
                "iframe",
                "object",
                "embed",
                "form",
                "input",
                "style",
              ]}
              unwrapDisallowed
              components={{
                p: ({ children }) => (
                  <p
                    className="my-2.5 leading-7"
                    style={{ color: COLORS.text }}
                  >
                    {children}
                  </p>
                ),
                a: ({ children, href }) => (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    className="underline decoration-current/30 underline-offset-4 transition-colors hover:decoration-current/70"
                    style={{ color: "#64b5ff" }}
                  >
                    {children}
                  </a>
                ),
                code: ({ children, className }) => {
                  const isFencedCode = Boolean(className);

                  return (
                    <code
                      className={
                        isFencedCode
                          ? className
                          : "rounded-[6px] px-1.5 py-0.5 font-mono text-[0.9em]"
                      }
                      style={
                        isFencedCode
                          ? undefined
                          : {
                              background:
                                "color-mix(in srgb, var(--text-primary) 8%, transparent)",
                              color: "var(--text-primary)",
                              border:
                                "1px solid color-mix(in srgb, var(--text-primary) 13%, transparent)",
                              boxShadow:
                                "inset 0 1px 0 color-mix(in srgb, white 12%, transparent)",
                              fontWeight: 500,
                            }
                      }
                    >
                      {children}
                    </code>
                  );
                },
                pre: ({ children }) => (
                  <pre
                    className="markdown-code-block my-4 overflow-x-auto rounded-[14px] border px-4 py-3.5 font-mono text-[12px] leading-6"
                    style={{
                      background:
                        "color-mix(in srgb, var(--app-bg) 92%, var(--text-primary) 8%)",
                      borderColor:
                        "color-mix(in srgb, var(--text-primary) 14%, transparent)",
                      color: "var(--text-primary)",
                      boxShadow:
                        "inset 0 1px 0 color-mix(in srgb, white 10%, transparent)",
                    }}
                  >
                    {children}
                  </pre>
                ),
              }}
            >
              {finalText}
            </ReactMarkdown>
          ) : (
            <ThinkingSkeleton statusText={agentStatus} />
          )}
        </div>
      )}

      <style jsx global>{`
        .markdown-code-block > code {
          display: block;
          min-width: max-content;
          padding: 0 !important;
          border: 0 !important;
          border-radius: 0 !important;
          background: transparent !important;
          color: inherit !important;
          box-shadow: none !important;
          font: inherit;
        }

        .markdown-code-block code::before,
        .markdown-code-block code::after {
          content: none !important;
        }
      `}</style>
    </div>
  );
}
