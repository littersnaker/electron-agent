/* eslint-disable react-hooks/purity */
"use client";

import { useMemo, useState } from "react";

export type AgentKind =
  | "orchestrator"
  | "planner"
  | "researcher"
  | "coder"
  | "reviewer"
  | "terminal";

export type AgentStatus =
  | "idle"
  | "queued"
  | "thinking"
  | "running"
  | "completed"
  | "error";

export interface AgentInstance {
  id: string;
  name: string;
  type: AgentKind;
  status: AgentStatus;
  progress: number;
  currentTask: string;
  updatedAt: number;
}

export const AGENT_BLUEPRINTS: Array<
  Pick<AgentInstance, "id" | "name" | "type" | "currentTask">
> = [
  {
    id: "orchestrator",
    name: "Orchestrator",
    type: "orchestrator",
    currentTask: "等待接收任务",
  },
  {
    id: "planner",
    name: "Planner",
    type: "planner",
    currentTask: "等待任务拆解",
  },
  {
    id: "researcher",
    name: "Researcher",
    type: "researcher",
    currentTask: "等待检索上下文",
  },
  {
    id: "coder",
    name: "Coding Agent",
    type: "coder",
    currentTask: "等待代码任务",
  },
  {
    id: "reviewer",
    name: "Reviewer",
    type: "reviewer",
    currentTask: "等待质量审查",
  },
  {
    id: "terminal",
    name: "Terminal Agent",
    type: "terminal",
    currentTask: "等待终端任务",
  },
];

export function createIdleAgents(): AgentInstance[] {
  return AGENT_BLUEPRINTS.map((agent) => ({
    ...agent,
    status: "idle",
    progress: 0,
    updatedAt: 0,
  }));
}

const AGENT_META: Record<
  AgentKind,
  { accent: string; soft: string; description: string; path: string }
> = {
  orchestrator: {
    accent: "#bf5af2",
    soft: "rgba(191,90,242,0.14)",
    description: "协调任务、分配角色并汇总结果",
    path: "M10 2.7c.48 3.42 2.41 5.35 5.83 5.83-3.42.48-5.35 2.41-5.83 5.83-.48-3.42-2.41-5.35-5.83-5.83C7.59 8.05 9.52 6.12 10 2.7Z",
  },
  planner: {
    accent: "#64b5ff",
    soft: "rgba(10,132,255,0.14)",
    description: "分析需求并拆分可执行步骤",
    path: "M5 4.2h10M5 8.1h10M5 12h6.5M5 15.9h4",
  },
  researcher: {
    accent: "#5ac8fa",
    soft: "rgba(90,200,250,0.14)",
    description: "搜索项目索引、文件和相关上下文",
    path: "M8.7 14.2a5.5 5.5 0 1 1 3.9-1.6l3.2 3.2",
  },
  coder: {
    accent: "#30d158",
    soft: "rgba(48,209,88,0.14)",
    description: "生成、修改并组织代码变更",
    path: "M7.2 6.2 3.5 10l3.7 3.8M12.8 6.2l3.7 3.8-3.7 3.8M11.5 3.8 8.5 16.2",
  },
  reviewer: {
    accent: "#ffd60a",
    soft: "rgba(255,214,10,0.14)",
    description: "检查差异、风险、测试和可维护性",
    path: "M4.2 10.2 8 14l7.8-8M4.5 4.2h6.2M4.5 7.2h4.2M11.8 14.5h3.7",
  },
  terminal: {
    accent: "#ff9f0a",
    soft: "rgba(255,159,10,0.14)",
    description: "执行命令并读取实时终端输出",
    path: "M4 5h12v10H4zM6.2 8l2 2-2 2M10.7 12h3",
  },
};

function statusLabel(status: AgentStatus): string {
  if (status === "running") return "运行中";
  if (status === "thinking") return "思考中";
  if (status === "queued") return "等待中";
  if (status === "completed") return "已完成";
  if (status === "error") return "异常";
  return "空闲";
}

function AgentGlyph({ type, status }: { type: AgentKind; status: AgentStatus }) {
  const meta = AGENT_META[type];
  const active = status === "running" || status === "thinking";

  return (
    <span
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px] border"
      style={{
        background: meta.soft,
        borderColor: active ? `${meta.accent}55` : "var(--border)",
        color: meta.accent,
        boxShadow: active ? `0 0 24px ${meta.soft}` : "none",
      }}
    >
      {active && (
        <span
          className="absolute inset-[-3px] animate-pulse rounded-[15px] border"
          style={{ borderColor: `${meta.accent}33` }}
        />
      )}
      <svg viewBox="0 0 20 20" className="h-[17px] w-[17px]" fill="none">
        <path
          d={meta.path}
          stroke="currentColor"
          strokeWidth="1.55"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill={type === "orchestrator" ? "currentColor" : "none"}
        />
      </svg>
    </span>
  );
}

interface AgentPanelProps {
  agents: AgentInstance[];
  isStreaming: boolean;
  className?: string;
}

export default function AgentPanel({
  agents,
  isStreaming,
  className = "",
}: AgentPanelProps) {
  const [expanded, setExpanded] = useState(true);

  const summary = useMemo(() => {
    const running = agents.filter((agent) =>
      ["running", "thinking"].includes(agent.status),
    ).length;
    const completed = agents.filter(
      (agent) => agent.status === "completed",
    ).length;
    const progress = agents.length
      ? Math.round(
          agents.reduce((total, agent) => total + agent.progress, 0) /
            agents.length,
        )
      : 0;
    return { running, completed, progress };
  }, [agents]);

  return (
    <aside
      className={`agent-panel flex min-h-0 w-[304px] shrink-0 flex-col overflow-hidden rounded-[22px] border ${className}`}
      style={{
        background:
          "linear-gradient(145deg, var(--glass-strong), var(--glass-soft))",
        borderColor: "var(--border)",
        boxShadow:
          "var(--shadow-card), inset 0 1px 0 rgba(255,255,255,0.08)",
        backdropFilter: "blur(34px) saturate(155%)",
        WebkitBackdropFilter: "blur(34px) saturate(155%)",
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex shrink-0 items-center justify-between px-4 py-4 text-left transition-colors hover:bg-[var(--glass-soft)]"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-[13px] border"
            style={{
              background:
                "linear-gradient(145deg, rgba(10,132,255,0.18), rgba(191,90,242,0.15))",
              borderColor: "var(--border)",
              color: "#83c5ff",
            }}
          >
            {isStreaming && (
              <span className="absolute inset-0 animate-ping rounded-[13px] border border-[#64b5ff]/20" />
            )}
            <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none">
              <circle cx="7" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="17" cy="7" r="2.2" stroke="currentColor" strokeWidth="1.6" />
              <circle cx="12" cy="17" r="2.2" stroke="currentColor" strokeWidth="1.6" />
              <path d="m8.8 8.5 2 6.2M15.2 8.5l-2 6.2M9.2 7h5.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate text-[13px] font-semibold tracking-[-0.01em]" style={{ color: "var(--text-primary)" }}>
                Agent Orchestra
              </h2>
              {summary.running > 0 && (
                <span className="rounded-full bg-[#0a84ff]/15 px-2 py-0.5 text-[9px] font-medium text-[#64b5ff]">
                  {summary.running} 运行中
                </span>
              )}
            </div>
            <p className="mt-0.5 text-[10px]" style={{ color: "var(--text-tertiary)" }}>
              {isStreaming
                ? `协作进度 ${summary.progress}%`
                : `${summary.completed}/${agents.length} 个角色已完成`}
            </p>
          </div>
        </div>
        <svg
          viewBox="0 0 20 20"
          className={`h-4 w-4 transition-transform duration-300 ${
            expanded ? "rotate-180" : ""
          }`}
          fill="none"
          style={{ color: "var(--text-tertiary)" }}
        >
          <path d="m5.5 7.5 4.5 4.5 4.5-4.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      <div className="mx-4 h-[3px] shrink-0 overflow-hidden rounded-full" style={{ background: "var(--glass)" }}>
        <span
          className="block h-full rounded-full transition-[width] duration-500"
          style={{
            width: `${summary.progress}%`,
            background: "linear-gradient(90deg, #0a84ff, #bf5af2)",
            boxShadow: "0 0 16px rgba(10,132,255,0.4)",
          }}
        />
      </div>

      {expanded && (
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-3">
          <div className="space-y-2">
            {agents.map((agent) => {
              const meta = AGENT_META[agent.type];
              const active = ["running", "thinking"].includes(agent.status);

              return (
                <article
                  key={agent.id}
                  className="agent-card relative overflow-hidden rounded-[16px] border px-3 py-3 transition-all duration-300"
                  style={{
                    background: active ? meta.soft : "var(--glass-soft)",
                    borderColor: active ? `${meta.accent}38` : "var(--border)",
                    boxShadow: active ? `0 12px 28px ${meta.soft}` : "none",
                  }}
                >
                  {active && (
                    <span
                      className="agent-shimmer pointer-events-none absolute inset-y-0 w-20"
                      style={{
                        background:
                          "linear-gradient(90deg, transparent, rgba(255,255,255,0.11), transparent)",
                      }}
                    />
                  )}

                  <div className="relative flex items-start gap-3">
                    <AgentGlyph type={agent.type} status={agent.status} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="truncate text-[12px] font-semibold" style={{ color: "var(--text-primary)" }}>
                          {agent.name}
                        </div>
                        <span
                          className="shrink-0 rounded-full px-2 py-0.5 text-[9px] font-medium"
                          style={{
                            color:
                              agent.status === "error"
                                ? "var(--accent-red)"
                                : active
                                  ? meta.accent
                                  : "var(--text-tertiary)",
                            background:
                              agent.status === "error"
                                ? "rgba(255,69,58,0.12)"
                                : active
                                  ? meta.soft
                                  : "var(--glass)",
                          }}
                        >
                          {statusLabel(agent.status)}
                        </span>
                      </div>
                      <p
                        className="mt-1 line-clamp-2 text-[10px] leading-4"
                        style={{ color: "var(--text-secondary)" }}
                        title={agent.currentTask || meta.description}
                      >
                        {agent.currentTask || meta.description}
                      </p>

                      <div className="mt-2.5 flex items-center gap-2">
                        <div className="h-[3px] min-w-0 flex-1 overflow-hidden rounded-full" style={{ background: "var(--glass)" }}>
                          <span
                            className="block h-full rounded-full transition-[width] duration-500"
                            style={{
                              width: `${Math.max(0, Math.min(100, agent.progress))}%`,
                              background: meta.accent,
                            }}
                          />
                        </div>
                        <span className="w-7 text-right font-mono text-[9px] tabular-nums" style={{ color: "var(--text-tertiary)" }}>
                          {agent.progress}%
                        </span>
                      </div>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </div>
      )}

      <style>{`
        @keyframes agentShimmer {
          from { transform: translateX(-140%); }
          to { transform: translateX(420%); }
        }
        @keyframes agentCardEnter {
          from { opacity: 0; transform: translateY(8px) scale(.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        .agent-card { animation: agentCardEnter 320ms var(--ease-apple); }
        .agent-shimmer { animation: agentShimmer 1.8s ease-in-out infinite; }
      `}</style>
    </aside>
  );
}
