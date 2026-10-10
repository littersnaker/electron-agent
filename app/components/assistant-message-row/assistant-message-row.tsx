"use client";
/**
 * 模块职责：助手消息渲染、Markdown 和工具活动整合。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { type AssistantMessageRowProps, COLORS, parseThinkingStream } from "./tool-activity-panel";
import { ThinkingSkeleton } from "./thinking-skeleton";
import { StepsTimeline } from "./steps-timeline";
import ThoughtLine from "./ThoughtLine";
export function AssistantMessageRow({
  content,
  workflow,
  workflowChoice,
  onWorkflowToggle,
  agentStatus,
  isStreaming = false,
}: AssistantMessageRowProps) {
  const [thinkingChoice, setThinkingChoice] = useState<{ thinking: boolean; open: boolean } | null>(
    null,
  );
  const { thinking, finalText, isThinking } = useMemo(
    () => parseThinkingStream(content),
    [content],
  );
  const isThinkingExpanded =
    thinkingChoice?.thinking === isThinking ? thinkingChoice.open : isThinking && isStreaming;

  const hasToolActivity = Boolean(
    workflow &&
    (workflow.toolActivities.length ||
      workflow.lifecycleEvents.length ||
      workflow.workListSnapshot?.items.length ||
      ["waiting", "failed"].includes(workflow.status)),
  );
  const hasVisibleContent = Boolean(thinking || finalText.trim());

  if (!hasVisibleContent && !hasToolActivity) {
    return <ThinkingSkeleton statusText={agentStatus} working={isStreaming} />;
  }

  return (
    <div className="flex w-full flex-col gap-3.5 ">
      <StepsTimeline
        workflow={workflow}
        isLive={isStreaming}
        choice={workflowChoice}
        onToggle={onWorkflowToggle}
      />

      {thinking && (
        <ThoughtLine
          working={isThinking && isStreaming}
          label="正在思考…"
          doneLabel="思考完成"
          showTimer={isThinking && isStreaming}
          open={isThinkingExpanded}
          onOpenChange={(open) => setThinkingChoice({ thinking: isThinking, open })}
        >
          <div className="text-[12px] leading-6 text-(--text-secondary)">
            {isThinkingExpanded && (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                urlTransform={(url: string) => (/^(https?:|data:image\/)/i.test(url) ? url : "")}
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
            )}
          </div>
        </ThoughtLine>
      )}

      {(finalText.trim() || (!isThinking && !hasToolActivity)) && (
        <div
          className="prose prose-sm max-w-none overflow-x-auto break-words leading-7 prose-headings:text-[var(--text-primary)] prose-strong:text-[var(--text-primary)] prose-li:text-[var(--text-primary)] prose-blockquote:text-[var(--text-secondary)] prose-blockquote:border-[var(--border-strong)]"
          style={{ color: COLORS.text }}
        >
          {finalText.trim() ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              urlTransform={(url: string) => (/^(https?:|data:image\/)/i.test(url) ? url : "")}
              disallowedElements={["script", "iframe", "object", "embed", "form", "input", "style"]}
              unwrapDisallowed
              components={{
                p: ({ children }) => (
                  <p className="my-2.5 leading-7" style={{ color: COLORS.text }}>
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
                              background: "color-mix(in srgb, var(--text-primary) 8%, transparent)",
                              color: "var(--text-primary)",
                              border:
                                "1px solid color-mix(in srgb, var(--text-primary) 13%, transparent)",
                              boxShadow: "inset 0 1px 0 color-mix(in srgb, white 12%, transparent)",
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
                      background: "color-mix(in srgb, var(--app-bg) 92%, var(--text-primary) 8%)",
                      borderColor: "color-mix(in srgb, var(--text-primary) 14%, transparent)",
                      color: "var(--text-primary)",
                      boxShadow: "inset 0 1px 0 color-mix(in srgb, white 10%, transparent)",
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
            <ThinkingSkeleton statusText={agentStatus} working={isStreaming} />
          )}
        </div>
      )}

      <style>{`
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
