"use client";
/**
 * 模块职责：助手消息渲染、Markdown 和工具活动整合。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type AssistantMessageRowProps, COLORS, ToolActivityPanel, parseThinkingStream } from "./tool-activity-panel";
import { ThinkingSkeleton } from "./thinking-skeleton";
import { StepsTimeline } from "./steps-timeline";
export function AssistantMessageRow({
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

      <StepsTimeline steps={toolActivities} />

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
                urlTransform={(url: string) =>
                  /^(https?:|data:image\/)/i.test(url) ? url : ""
                }
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
                urlTransform={(url: string) =>
                  /^(https?:|data:image\/)/i.test(url) ? url : ""
                }
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
                    style={{ color: "var(--accent-blue-hover)" }}
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
