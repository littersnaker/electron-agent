// 模块说明：负责 InteractiveRequestPanel 用户界面组件。
"use client";

import { APPROVAL_KIND_META } from "./interactive-approval-meta";
import type { InteractiveRequest } from "../types/workspace";

interface InteractiveRequestPanelProps {
  request: InteractiveRequest;
  answer: string;
  onAnswerChange: (value: string) => void;
  onReply: (mode: "auto" | "llm" | "user", answer?: string) => void;
}

function FileCreateConfirmationCard({
  request,
  onReply,
}: Pick<InteractiveRequestPanelProps, "request" | "onReply">) {
  const createOption =
    request.options.find((option) => option.value === "create") || request.options[0];
  const cancelOption =
    request.options.find((option) => option.value === "cancel") || request.options[1];

  return (
    <section
      className="mb-3 overflow-hidden rounded-[22px] border"
      style={{
        background: "color-mix(in srgb, var(--glass-strong) 92%, transparent)",
        borderColor: "color-mix(in srgb, var(--border) 82%, white 18%)",
        boxShadow: "0 18px 55px rgba(0,0,0,0.12), inset 0 1px 0 rgba(255,255,255,0.10)",
        backdropFilter: "blur(32px) saturate(150%)",
        WebkitBackdropFilter: "blur(32px) saturate(150%)",
      }}
      aria-live="polite"
    >
      <div className="flex items-start gap-3.5 px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border"
          style={{
            background: "var(--accent-blue-soft)",
            borderColor: "var(--accent-blue-border)",
            color: "var(--accent-blue)",
          }}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
            <path
              d="M7 3.75h6.8L18 7.95v12.3H7z"
              stroke="currentColor"
              strokeWidth="1.55"
              strokeLinejoin="round"
            />
            <path
              d="M13.75 3.9v4.25h4.05M12.5 11v6M9.5 14h6"
              stroke="currentColor"
              strokeWidth="1.55"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <p
            className="text-[13px] font-semibold tracking-[-0.01em]"
            style={{ color: "var(--text-primary)" }}
          >
            {request.title || "没有找到目标文件"}
          </p>
          <p
            className="mt-1 text-[12px] font-medium leading-5"
            style={{ color: "var(--text-secondary)" }}
          >
            {request.prompt}
          </p>
          {request.description && (
            <p
              className="mt-1.5 max-w-[720px] text-[11px] leading-[1.65]"
              style={{ color: "var(--text-tertiary)" }}
            >
              {request.description}
            </p>
          )}

          {request.filePath && (
            <div
              className="mt-3 inline-flex max-w-full items-center rounded-[8px] border px-2.5 py-1.5 font-mono text-[10px]"
              style={{
                background: "var(--glass-black)",
                borderColor: "var(--border)",
                color: "var(--text-secondary)",
              }}
            >
              <span className="truncate">{request.filePath}</span>
            </div>
          )}
        </div>
      </div>

      <div
        className="flex items-center justify-end gap-2 border-t px-4 py-3 sm:px-5"
        style={{ borderColor: "var(--border)" }}
      >
        <button
          type="button"
          onClick={() => onReply("user", cancelOption?.value || "cancel")}
          className="h-9 rounded-[10px] border px-3.5 text-[11px] font-semibold transition-[background,transform] hover:bg-[var(--glass-hover)] active:scale-[0.98]"
          style={{
            background: "var(--glass)",
            borderColor: "var(--border)",
            color: "var(--text-secondary)",
          }}
        >
          {cancelOption?.label || "暂不新建"}
        </button>
        <button
          type="button"
          onClick={() => onReply("user", createOption?.value || "create")}
          className="h-9 rounded-[10px] px-3.5 text-[11px] font-semibold text-white shadow-[0_5px_18px_rgba(10,132,255,0.24)] transition-[filter,transform] hover:brightness-105 active:scale-[0.98]"
          style={{ background: "var(--accent-blue)" }}
        >
          {createOption?.label || "新建并继续"}
        </button>
      </div>
    </section>
  );
}

function RiskApprovalCard({
  request,
  onReply,
}: Pick<InteractiveRequestPanelProps, "request" | "onReply">) {
  const approveOption =
    request.options.find((option) => option.value === "approve") || request.options[0];
  const rejectOption =
    request.options.find((option) => option.value === "reject") || request.options[1];
  const isHighRisk = request.riskLevel === "high";
  const kindMeta = APPROVAL_KIND_META[request.approvalKind ?? ""];
  // 主按钮色：高风险红示警；其余回归全局蓝色 CTA 体系（不再用橙黄误导读作警告）。
  const approveColor = isHighRisk ? "#ff453a" : "var(--accent-blue)";
  const argumentPreview =
    request.toolArguments && Object.keys(request.toolArguments).length > 0
      ? JSON.stringify(request.toolArguments, null, 2)
      : "";

  return (
    <section
      className="mb-3 overflow-hidden rounded-[22px] border"
      style={{
        background: "color-mix(in srgb, var(--glass-strong) 94%, transparent)",
        borderColor: isHighRisk ? "rgba(255,69,58,0.34)" : "rgba(255,159,10,0.34)",
        boxShadow: "0 18px 55px rgba(0,0,0,0.13), inset 0 1px 0 rgba(255,255,255,0.10)",
      }}
      aria-live="polite"
    >
      <div className="flex items-start gap-3.5 px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border"
          style={{
            background: isHighRisk ? "rgba(255,69,58,0.11)" : "rgba(255,159,10,0.11)",
            borderColor: isHighRisk ? "rgba(255,69,58,0.22)" : "rgba(255,159,10,0.22)",
            color: isHighRisk ? "#ff453a" : "var(--accent-blue)",
          }}
          aria-hidden="true"
        >
          {kindMeta?.icon ?? (
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
              <path
                d="M12 3.5 20 7v5.5c0 4.6-3.2 7.4-8 8.5-4.8-1.1-8-3.9-8-8.5V7z"
                stroke="currentColor"
                strokeWidth="1.55"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
              {request.title || "操作需要人工批准"}
            </p>
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase"
              style={{
                background: isHighRisk ? "rgba(255,69,58,0.12)" : "rgba(255,159,10,0.12)",
                color: isHighRisk ? "#ff453a" : "#ff9f0a",
              }}
            >
              {isHighRisk ? "高风险" : "需确认"}
            </span>
          </div>
          <p
            className="mt-1 text-[12px] font-medium leading-5"
            style={{ color: "var(--text-secondary)" }}
          >
            {request.prompt}
          </p>
          {request.description && (
            <p
              className="mt-1.5 text-[11px] leading-[1.65]"
              style={{ color: "var(--text-tertiary)" }}
            >
              {request.description}
            </p>
          )}
          {kindMeta && (
            <p className="mt-1 text-[11px] leading-[1.6]" style={{ color: "var(--text-tertiary)" }}>
              {kindMeta.purpose}
            </p>
          )}

          {request.toolName && (
            <div
              className="mt-3 rounded-[10px] border px-3 py-2 font-mono text-[10px]"
              style={{
                background: "var(--glass-black)",
                borderColor: "var(--border)",
                color: "var(--text-secondary)",
              }}
            >
              工具：{request.toolName}
            </div>
          )}
          {argumentPreview && (
            <pre
              className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-[10px] border px-3 py-2 font-mono text-[10px] leading-5"
              style={{
                background: "var(--glass-black)",
                borderColor: "var(--border)",
                color: "var(--text-tertiary)",
              }}
            >
              {argumentPreview}
            </pre>
          )}
          {request.recentOutput && (
            <pre
              className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-[10px] border px-3 py-2 font-mono text-[10px] leading-5"
              style={{
                background: "var(--glass-black)",
                borderColor: "var(--border)",
                color: "var(--text-tertiary)",
              }}
            >
              {request.recentOutput}
            </pre>
          )}
        </div>
      </div>

      <div
        className="flex justify-end gap-2 border-t px-4 py-3 sm:px-5"
        style={{ borderColor: "var(--border)" }}
      >
        <button
          type="button"
          onClick={() => onReply("user", rejectOption?.value || "reject")}
          className="h-9 rounded-[10px] border px-3.5 text-[11px] font-semibold active:scale-[0.98]"
          style={{
            background: "var(--glass)",
            borderColor: "var(--border)",
            color: "var(--text-secondary)",
          }}
        >
          {rejectOption?.label || "拒绝"}
        </button>
        <button
          type="button"
          onClick={() => onReply("user", approveOption?.value || "approve")}
          className="h-9 rounded-[10px] px-3.5 text-[11px] font-semibold text-white active:scale-[0.98]"
          style={{ background: approveColor }}
        >
          {approveOption?.label || "批准并继续"}
        </button>
      </div>
    </section>
  );
}

function TerminalInteractiveCard({
  request,
  answer,
  onAnswerChange,
  onReply,
}: InteractiveRequestPanelProps) {
  return (
    <section
      className="mb-3 overflow-hidden rounded-[20px] border"
      style={{
        background: "linear-gradient(180deg, var(--glass), var(--glass-soft))",
        borderColor: "var(--accent-blue-border)",
        boxShadow: "var(--shadow-soft), inset 0 1px 0 rgba(255,255,255,0.055)",
      }}
    >
      <div className="flex items-start gap-3 px-4 py-3.5">
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px]"
          style={{ background: "var(--accent-blue-soft-strong)", color: "var(--accent-blue)" }}
        >
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none">
            <path
              d="M5 6.5h14v11H5z"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinejoin="round"
            />
            <path
              d="m8 10 2 2-2 2M12.5 14h3.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-semibold">终端需要你的选择</div>
              <div className="mt-0.5 text-[10px] text-[var(--text-tertiary)]">
                第 {request.promptRound} 次交互 · 保持当前进程
              </div>
            </div>
            <span
              className="rounded-full px-2 py-1 font-mono text-[10px] uppercase"
              style={{ background: "var(--accent-blue-soft)", color: "var(--accent-blue)" }}
            >
              {request.mode}
            </span>
          </div>

          <div className="mt-3 text-[11px] text-[var(--text-tertiary)]">运行命令</div>
          <div
            className="mt-1 rounded-[10px] border px-3 py-2 font-mono text-[11px] leading-5"
            style={{
              background: "var(--glass-black)",
              borderColor: "var(--border)",
              color: "var(--text-primary)",
            }}
          >
            {request.command}
          </div>

          <div className="mt-3 whitespace-pre-wrap text-[12px] leading-5 text-[var(--text-secondary)]">
            {request.prompt}
          </div>
        </div>
      </div>

      <div
        className="mx-4 max-h-40 overflow-auto whitespace-pre-wrap rounded-[12px] border p-3 font-mono text-[10px] leading-5"
        style={{
          background: "var(--glass-black)",
          borderColor: "var(--border)",
          color: "var(--text-secondary)",
        }}
      >
        {request.recentOutput || "终端正在等待更多输出…"}
      </div>

      <div className="flex flex-wrap gap-2 px-4 pb-3 pt-3">
        {request.options.map((option, index) => (
          <button
            key={`${request.id}-${option.value}`}
            type="button"
            onClick={() => onReply("user", option.value)}
            className="rounded-[10px] border px-3 py-2 text-[11px] font-medium transition-all hover:-translate-y-px active:translate-y-0"
            style={{
              background:
                index === 0
                  ? "linear-gradient(180deg, var(--accent-blue-gradient-start), var(--accent-blue-gradient-end))"
                  : "var(--glass)",
              borderColor: index === 0 ? "var(--accent-blue-border-strong)" : "var(--border)",
              color: index === 0 ? "white" : "var(--text-secondary)",
            }}
          >
            {option.label}
          </button>
        ))}

        <button
          type="button"
          onClick={() => onReply("auto")}
          className="rounded-[10px] border px-3 py-2 text-[11px] font-medium transition-colors hover:bg-[var(--glass-hover)]"
          style={{
            background: "var(--glass)",
            borderColor: "var(--border)",
            color: "var(--text-secondary)",
          }}
        >
          自动选择
        </button>

        <button
          type="button"
          onClick={() => onReply("llm")}
          className="rounded-[10px] border px-3 py-2 text-[11px] font-medium transition-colors hover:bg-[var(--glass-hover)]"
          style={{
            background: "var(--glass)",
            borderColor: "var(--border)",
            color: "var(--text-secondary)",
          }}
        >
          交给 Agent
        </button>
      </div>

      <div className="flex gap-2 border-t px-4 py-3" style={{ borderColor: "var(--border)" }}>
        <input
          value={answer}
          onChange={(event) => onAnswerChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onReply("user");
            }
          }}
          placeholder="输入自定义回答，留空表示发送回车"
          className="h-9 min-w-0 flex-1 rounded-[10px] border bg-[var(--glass-black)] px-3 text-[11px] outline-none placeholder:text-[var(--text-quaternary)] focus:border-[var(--accent-blue)]"
          style={{ borderColor: "var(--border)", color: "var(--text-primary)" }}
        />
        <button
          type="button"
          onClick={() => onReply("user")}
          className="h-9 rounded-[10px] px-3 text-[11px] font-semibold text-white transition-all active:scale-[0.98]"
          style={{ background: "var(--accent-blue)" }}
        >
          发送输入
        </button>
      </div>
    </section>
  );
}

/**
 * 漫剧分镜确认卡：结构化展示分镜表（镜号/景别/标题/时长/台词）与角色，
 * 只保留确认/拒绝两个动作——避免终端卡的「自动选择/交给 Agent/自由输入」
 * 误触直接取消整个生成流程。
 */
function ComicStoryboardCard({
  request,
  onReply,
}: Pick<InteractiveRequestPanelProps, "request" | "onReply">) {
  const approveOption =
    request.options.find((option) => option.value === "approve") || request.options[0];
  const rejectOption =
    request.options.find((option) => option.value === "reject") || request.options[1];
  const arguments_ = (request.toolArguments ?? {}) as {
    storyboard?: Array<Record<string, unknown>>;
    characters?: Array<Record<string, unknown>>;
  };
  const storyboard = Array.isArray(arguments_.storyboard) ? arguments_.storyboard : [];
  const characters = Array.isArray(arguments_.characters) ? arguments_.characters : [];

  return (
    <section
      className="mb-3 overflow-hidden rounded-[22px] border"
      style={{
        background: "color-mix(in srgb, var(--glass-strong) 94%, transparent)",
        borderColor: "var(--accent-blue-border-strong)",
        boxShadow: "0 18px 55px rgba(0,0,0,0.13), inset 0 1px 0 rgba(255,255,255,0.10)",
      }}
      aria-live="polite"
    >
      <div className="flex items-start gap-3.5 px-4 pb-3 pt-4 sm:px-5 sm:pt-5">
        <span
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px] border"
          style={{
            background: "var(--accent-blue-soft)",
            borderColor: "var(--accent-blue-border)",
            color: "var(--accent-blue)",
          }}
        >
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
            <rect
              x="3.5"
              y="4.5"
              width="17"
              height="15"
              rx="2"
              stroke="currentColor"
              strokeWidth="1.55"
            />
            <path
              d="M3.5 8.5h17M7.5 4.5v4M12 4.5v4M16.5 4.5v4"
              stroke="currentColor"
              strokeWidth="1.4"
            />
            <path
              d="m10 11.5 4.5 2.5-4.5 2.5z"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
        </span>

        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
            {request.title || "分镜表确认"}
          </p>
          <p
            className="mt-1 text-[12px] font-medium leading-5"
            style={{ color: "var(--text-secondary)" }}
          >
            {request.prompt}
          </p>
          {characters.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                角色一致性锚点：
              </span>
              {characters.map((character) => (
                <span
                  key={String(character.name)}
                  className="rounded-full border px-2 py-0.5 text-[10px]"
                  style={{
                    background: "var(--glass)",
                    borderColor: "var(--border)",
                    color: "var(--text-secondary)",
                  }}
                >
                  {String(character.name)}
                </span>
              ))}
            </div>
          )}

          <div
            className="mt-3 max-h-64 space-y-1.5 overflow-y-auto rounded-[12px] border p-2"
            style={{ background: "var(--glass-black)", borderColor: "var(--border)" }}
          >
            {storyboard.map((shot, index) => (
              <div
                key={String(shot.index ?? index)}
                className="flex items-start gap-2 rounded-[8px] px-2 py-1.5"
                style={{ background: "var(--glass)" }}
              >
                <span
                  className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold"
                  style={{
                    background: "var(--accent-blue-soft-strong)",
                    color: "var(--accent-blue)",
                  }}
                >
                  {String(shot.index ?? index + 1)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span
                      className="text-[11px] font-medium"
                      style={{ color: "var(--text-primary)" }}
                    >
                      {String(shot.title ?? "")}
                    </span>
                    <span
                      className="rounded-full px-1.5 py-0.5 text-[10px]"
                      style={{ background: "var(--glass)", color: "var(--text-tertiary)" }}
                    >
                      {String(shot.shot_type ?? "中景")}
                    </span>
                    <span className="text-[10px]" style={{ color: "var(--text-tertiary)" }}>
                      {String(shot.duration ?? 5)}s
                    </span>
                  </div>
                  {Boolean(shot.dialogue) && (
                    <p
                      className="mt-0.5 line-clamp-2 text-[10px] leading-4"
                      style={{ color: "var(--text-tertiary)" }}
                    >
                      {String(shot.dialogue)}
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
          {request.description && (
            <p
              className="mt-1.5 text-[11px] leading-[1.65]"
              style={{ color: "var(--text-tertiary)" }}
            >
              {request.description}
            </p>
          )}
        </div>
      </div>

      <div
        className="flex items-center justify-end gap-2 border-t px-4 py-3 sm:px-5"
        style={{ borderColor: "var(--border)" }}
      >
        <button
          type="button"
          onClick={() => onReply("user", rejectOption?.value || "reject")}
          className="h-9 rounded-[10px] border px-3.5 text-[11px] font-semibold transition-[background,transform] hover:bg-[var(--glass-hover)] active:scale-[0.98]"
          style={{
            background: "var(--glass)",
            borderColor: "var(--border)",
            color: "var(--text-secondary)",
          }}
        >
          {rejectOption?.label || "拒绝重来"}
        </button>
        <button
          type="button"
          onClick={() => onReply("user", approveOption?.value || "approve")}
          className="h-9 rounded-[10px] px-3.5 text-[11px] font-semibold text-white shadow-[0_5px_18px_rgba(10,132,255,0.24)] transition-[filter,transform] hover:brightness-105 active:scale-[0.98]"
          style={{ background: "var(--accent-blue)" }}
        >
          {approveOption?.label || "确认并开始生成"}
        </button>
      </div>
    </section>
  );
}

/**
 * 统一的交互请求面板。
 *
 * 缺失文件确认使用简洁的 Apple 风格双按钮卡片；现有 PTY/CLI 交互保持原来的
 * 终端信息密度，两类请求共用同一个 SSE/回复通道，不需要额外接口。
 */
export default function InteractiveRequestPanel(props: InteractiveRequestPanelProps) {
  if (props.request.source === "file_create_confirmation") {
    return <FileCreateConfirmationCard request={props.request} onReply={props.onReply} />;
  }

  if (props.request.source === "media_storyboard") {
    return <ComicStoryboardCard request={props.request} onReply={props.onReply} />;
  }

  if (props.request.source === "risk_approval" || props.request.source === "mcp_tool_approval") {
    return <RiskApprovalCard request={props.request} onReply={props.onReply} />;
  }

  return <TerminalInteractiveCard {...props} />;
}
