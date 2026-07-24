"use client";

import { useCallback, useMemo, useState } from "react";
import { createIdleAgents } from "../component/AgentPanel";
import type {
  AgentInstance,
  AgentKind,
  AgentStatus,
} from "../component/AgentPanel";
import type {
  AgentEventPayload,
  AgentLifecycleEventPayload,
  InteractiveRequest,
  StreamPacketType,
} from "../types/workspace";
import type { CommerceProgressEvent } from "../lib/commerce/types";
import { createRunAgents, normalizeAgentKind } from "../utils/agentRuntime";

const LIFECYCLE_ROLE_TO_AGENT: Record<string, AgentKind> = {
  router: "orchestrator",
  search_agent: "researcher",
  memory_agent: "researcher",
  file_agent: "researcher",
  context_merge: "orchestrator",
  high_level_planner: "planner",
  task_planner: "planner",
  modify_worker: "coder",
  merge_agent: "orchestrator",
  reviewer_agent: "reviewer",
  verification_agent: "terminal",
  final_report_agent: "orchestrator",
};

function lifecycleToAgentStatus(
  status: string,
): { status: AgentStatus; progress: number } {
  if (status === "COMPLETED") return { status: "completed", progress: 100 };
  if (status === "FAILED") return { status: "error", progress: 100 };
  if (status === "CREATED") return { status: "queued", progress: 0 };
  if (status === "PLANNING" || status === "REVIEWING") {
    return { status: "thinking", progress: 46 };
  }
  if (status === "READY_TO_MERGE") {
    return { status: "running", progress: 88 };
  }
  if (status === "BLOCKED") {
    return { status: "running", progress: 72 };
  }
  return { status: "running", progress: 58 };
}

export function useAgentCoordinator() {
  const [agents, setAgents] = useState<AgentInstance[]>(() => createIdleAgents());

  const runningAgentCount = useMemo(
    () =>
      agents.filter((agent) =>
        ["running", "thinking"].includes(agent.status),
      ).length,
    [agents],
  );

  const resetAgents = useCallback(() => {
    setAgents(createIdleAgents());
  }, []);

  /** 普通 QA / Code 任务沿用原有 Agent 编排。 */
  const beginRun = useCallback(() => {
    setAgents(createRunAgents());
  }, []);

  const updateAgent = useCallback(
    (
      kind: AgentKind,
      patch: Partial<Omit<AgentInstance, "id" | "type">>,
    ) => {
      setAgents((current) =>
        current.map((agent) =>
          agent.type === kind
            ? { ...agent, ...patch, updatedAt: Date.now() }
            : agent,
        ),
      );
    },
    [],
  );

  /**
   * 媒体任务只激活真正参与的 Orchestrator / Media / Reviewer。
   * 其余 Code Agent 保持 idle，避免面板出现“全部角色 0%”的假进度。
   */
  const beginMediaRun = useCallback((taskName: string) => {
    const now = Date.now();
    setAgents(
      createIdleAgents().map((agent) => {
        if (agent.type === "orchestrator") {
          return {
            ...agent,
            status: "running" as const,
            progress: 12,
            currentTask: `识别并编排${taskName}`,
            updatedAt: now,
          };
        }
        if (agent.type === "media") {
          return {
            ...agent,
            status: "running" as const,
            progress: 8,
            currentTask: `准备${taskName}模型请求`,
            updatedAt: now,
          };
        }
        if (agent.type === "reviewer") {
          return {
            ...agent,
            status: "queued" as const,
            progress: 0,
            currentTask: "等待生成结果后进行检查",
            updatedAt: now,
          };
        }
        return agent;
      }),
    );
  }, []);

  /** 根据媒体请求等待时长平滑推进进度，但不会在结果返回前超过 90%。 */
  const updateMediaProgress = useCallback((progress: number, task: string) => {
    const safeProgress = Math.max(8, Math.min(90, Math.round(progress)));
    setAgents((current) =>
      current.map((agent) => {
        if (agent.type === "orchestrator") {
          return {
            ...agent,
            status: "running" as const,
            progress: Math.min(88, Math.max(agent.progress, safeProgress - 8)),
            currentTask: "协调媒体模型并等待结果返回",
            updatedAt: Date.now(),
          };
        }
        if (agent.type === "media") {
          return {
            ...agent,
            status:
              safeProgress >= 78
                ? ("completed" as const)
                : ("running" as const),
            progress:
              safeProgress >= 78
                ? 100
                : Math.max(agent.progress, safeProgress),
            currentTask:
              safeProgress >= 78
                ? "媒体内容已生成，正在交给 Reviewer 检查"
                : task,
            updatedAt: Date.now(),
          };
        }
        if (agent.type === "reviewer" && safeProgress >= 78) {
          return {
            ...agent,
            status: "running" as const,
            progress: Math.max(agent.progress, Math.min(86, safeProgress - 8)),
            currentTask: task.includes("检查")
              ? task
              : "正在检查重影、重复元素和无关改动",
            updatedAt: Date.now(),
          };
        }
        return agent;
      }),
    );
  }, []);

  const completeMediaRun = useCallback((reviewTask: string) => {
    setAgents((current) =>
      current.map((agent) => {
        if (agent.type === "orchestrator") {
          return {
            ...agent,
            status: "completed" as const,
            progress: 100,
            currentTask: "媒体任务编排完成",
            updatedAt: Date.now(),
          };
        }
        if (agent.type === "media") {
          return {
            ...agent,
            status: "completed" as const,
            progress: 100,
            currentTask: "媒体文件已生成并保存",
            updatedAt: Date.now(),
          };
        }
        if (agent.type === "reviewer") {
          return {
            ...agent,
            status: "completed" as const,
            progress: 100,
            currentTask: reviewTask,
            updatedAt: Date.now(),
          };
        }
        return agent;
      }),
    );
  }, []);

  const failMediaRun = useCallback((message: string) => {
    setAgents((current) =>
      current.map((agent) =>
        agent.type === "orchestrator" || agent.type === "media"
          ? {
              ...agent,
              status: "error" as const,
              progress: 100,
              currentTask: message,
              updatedAt: Date.now(),
            }
          : agent,
      ),
    );
  }, []);

  /** 跨境市场情报会话只激活真正参与的角色，避免 Code Agent 角色产生假进度。 */
  const beginCommerceRun = useCallback(() => {
    const now = Date.now();
    setAgents(
      createIdleAgents().map((agent) => {
        if (agent.type === "orchestrator") {
          return {
            ...agent,
            status: "running" as const,
            progress: 8,
            currentTask: "编排跨境公开市场研究流程",
            updatedAt: now,
          };
        }
        if (agent.type === "commerce") {
          return {
            ...agent,
            status: "thinking" as const,
            progress: 8,
            currentTask: "理解品类与运营目标",
            updatedAt: now,
          };
        }
        if (agent.type === "researcher") {
          return {
            ...agent,
            status: "queued" as const,
            progress: 0,
            currentTask: "等待检索计划后采集公开 SERP / Shopping 数据",
            updatedAt: now,
          };
        }
        if (agent.type === "reviewer") {
          return {
            ...agent,
            status: "queued" as const,
            progress: 0,
            currentTask: "等待市场指标完成后检查数据限制",
            updatedAt: now,
          };
        }
        return agent;
      }),
    );
  }, []);

  /** 根据 Commerce Route 的结构化阶段事件更新右侧 Agent 面板。 */
  const updateCommerceProgress = useCallback((event: CommerceProgressEvent) => {
    const now = Date.now();
    setAgents((current) =>
      current.map((agent) => {
        const collecting =
          event.stage === "collect" || event.stage === "normalize";
        const reviewing = event.stage === "strategy";
        const finished = event.stage === "done";

        if (agent.type === "orchestrator") {
          return {
            ...agent,
            status: finished ? ("completed" as const) : ("running" as const),
            progress: finished
              ? 100
              : Math.max(agent.progress, event.progress - 6),
            currentTask: finished
              ? "跨境市场情报研究已完成"
              : `协调：${event.detail}`,
            updatedAt: now,
          };
        }
        if (agent.type === "commerce") {
          return {
            ...agent,
            status: finished
              ? ("completed" as const)
              : collecting
                ? ("queued" as const)
                : ("running" as const),
            progress: finished ? 100 : Math.max(agent.progress, event.progress),
            currentTask: event.detail,
            updatedAt: now,
          };
        }
        if (agent.type === "researcher") {
          if (collecting) {
            return {
              ...agent,
              status: "running" as const,
              progress: Math.max(agent.progress, event.progress),
              currentTask: event.detail,
              updatedAt: now,
            };
          }
          if (["analyze", "strategy", "done"].includes(event.stage)) {
            return {
              ...agent,
              status: "completed" as const,
              progress: 100,
              currentTask: "Amazon 商品样本已采集并标准化",
              updatedAt: now,
            };
          }
        }
        if (agent.type === "reviewer" && (reviewing || finished)) {
          return {
            ...agent,
            status: finished ? ("completed" as const) : ("running" as const),
            progress: finished
              ? 100
              : Math.max(agent.progress, event.progress - 8),
            currentTask: finished
              ? "数据口径与风险提示已检查"
              : "检查估算口径并整理运营建议",
            updatedAt: now,
          };
        }
        return agent;
      }),
    );
  }, []);

  const failCommerceRun = useCallback((message: string) => {
    setAgents((current) =>
      current.map((agent) => {
        const isPrimary =
          agent.type === "orchestrator" || agent.type === "commerce";
        const isActiveResearcher =
          agent.type === "researcher" &&
          ["running", "thinking"].includes(agent.status);

        if (!isPrimary && !isActiveResearcher) return agent;

        return {
          ...agent,
          status: "error" as const,
          progress: 100,
          currentTask: message,
          updatedAt: Date.now(),
        };
      }),
    );
  }, []);

  const activateAgent = useCallback((kind: AgentKind, task: string) => {
    setAgents((current) =>
      current.map((agent) => {
        if (agent.type === kind) {
          return {
            ...agent,
            status: "running" as const,
            progress: Math.max(agent.progress, agent.progress >= 90 ? 90 : 24),
            currentTask: task || agent.currentTask,
            updatedAt: Date.now(),
          };
        }

        if (
          agent.type !== "orchestrator" &&
          ["running", "thinking"].includes(agent.status)
        ) {
          return {
            ...agent,
            status: "completed" as const,
            progress: 100,
            updatedAt: Date.now(),
          };
        }

        if (agent.type === "orchestrator") {
          return {
            ...agent,
            status: "running" as const,
            progress: Math.max(agent.progress, 32),
            currentTask: `协调 ${task || "当前步骤"}`,
            updatedAt: Date.now(),
          };
        }

        return agent;
      }),
    );
  }, []);

  const applyAgentEvent = useCallback(
    (
      eventType: StreamPacketType | undefined,
      payload?: AgentEventPayload,
      fallbackText = "",
    ) => {
      if (!payload && !fallbackText) return;

      const kind = normalizeAgentKind(payload?.type || payload?.id);
      const task = payload?.currentTask || payload?.task || fallbackText;
      const status: AgentStatus =
        payload?.status ||
        (eventType === "AGENT_FINISH"
          ? "completed"
          : eventType === "AGENT_ERROR"
            ? "error"
            : eventType === "AGENT_START"
              ? "running"
              : "thinking");
      const progress = Math.max(
        0,
        Math.min(
          100,
          payload?.progress ??
            (status === "completed" || status === "error" ? 100 : 48),
        ),
      );

      setAgents((current) =>
        current.map((agent) =>
          agent.id === payload?.id || agent.type === kind
            ? {
                ...agent,
                name: payload?.name || agent.name,
                status,
                progress,
                currentTask: task || agent.currentTask,
                updatedAt: Date.now(),
              }
            : agent,
        ),
      );
    },
    [],
  );

  /**
   * 使用后端真实 lifecycle 更新角色状态。
   *
   * 特别处理返工：当 iteration > 0 的 Worker 重新启动时，把 Reviewer/Terminal
   * 重置为 queued，避免旧一轮的 completed 状态继续误导任务面板。
   */
  const applyLifecycleEvent = useCallback(
    (event: AgentLifecycleEventPayload) => {
      const kind = LIFECYCLE_ROLE_TO_AGENT[event.role] || "orchestrator";
      const mapped = lifecycleToAgentStatus(event.status);
      const retryRound = event.iteration > 0 ? event.iteration + 1 : 0;
      const taskPrefix = retryRound > 0 ? `第 ${retryRound} 轮返工 · ` : "";

      setAgents((current: AgentInstance[]) =>
        current.map((agent: AgentInstance) => {
          if (
            event.iteration > 0 &&
            ["coder", "orchestrator"].includes(kind) &&
            (agent.type === "terminal" || agent.type === "reviewer")
          ) {
            return {
              ...agent,
              status: "queued" as const,
              progress: 0,
              currentTask:
                agent.type === "terminal"
                  ? "等待返工合并后重新验证"
                  : "等待返工验证完成后重新审查",
              updatedAt: Date.now(),
            };
          }

          if (agent.type === kind) {
            return {
              ...agent,
              status: mapped.status,
              progress:
                mapped.status === "running" || mapped.status === "thinking"
                  ? Math.max(agent.progress > 95 ? 0 : agent.progress, mapped.progress)
                  : mapped.progress,
              currentTask: `${taskPrefix}${event.detail}`,
              updatedAt: Date.now(),
            };
          }

          if (agent.type === "orchestrator" && kind !== "orchestrator") {
            return {
              ...agent,
              status: "running" as const,
              progress: Math.max(agent.progress, 32),
              currentTask: `协调 ${taskPrefix}${event.detail}`,
              updatedAt: Date.now(),
            };
          }

          return agent;
        }),
      );
    },
    [],
  );

  const markFinalResponse = useCallback(() => {
    setAgents((current) =>
      current.map((agent) => {
        if (agent.type === "orchestrator") {
          return {
            ...agent,
            status: "running" as const,
            progress: Math.max(agent.progress, 88),
            currentTask: "汇总已执行步骤并生成最终回答",
            updatedAt: Date.now(),
          };
        }
        if (["running", "thinking"].includes(agent.status)) {
          return {
            ...agent,
            status: "completed" as const,
            progress: 100,
            updatedAt: Date.now(),
          };
        }
        return agent;
      }),
    );
  }, []);

  const failRunningAgents = useCallback(() => {
    setAgents((current) =>
      current.map((agent) =>
        ["running", "thinking"].includes(agent.status)
          ? {
              ...agent,
              status: "error" as const,
              progress: 100,
              currentTask: "当前 Agent 执行失败",
              updatedAt: Date.now(),
            }
          : agent,
      ),
    );
  }, []);

  const finalizeAgents = useCallback(
    (interactiveRequest: InteractiveRequest | null) => {
      setAgents((current) =>
        current.map((agent) => {
          if (agent.status === "error") return agent;
          if (
            interactiveRequest?.source === "file_create_confirmation" &&
            agent.type === "orchestrator"
          ) {
            return {
              ...agent,
              status: "running" as const,
              progress: Math.max(agent.progress, 38),
              currentTask: "等待确认是否新建缺失文件",
              updatedAt: Date.now(),
            };
          }
          if (
            interactiveRequest &&
            interactiveRequest.source !== "file_create_confirmation" &&
            agent.type === "terminal"
          ) {
            return {
              ...agent,
              status: "running" as const,
              progress: Math.max(agent.progress, 72),
              currentTask: "等待用户输入后继续执行",
              updatedAt: Date.now(),
            };
          }
          if (agent.type === "orchestrator") {
            return {
              ...agent,
              status: "completed" as const,
              progress: 100,
              currentTask: "本轮协作已完成",
              updatedAt: Date.now(),
            };
          }
          if (["running", "thinking"].includes(agent.status)) {
            return {
              ...agent,
              status: "completed" as const,
              progress: 100,
              updatedAt: Date.now(),
            };
          }
          return agent;
        }),
      );
    },
    [],
  );

  return {
    agents,
    runningAgentCount,
    resetAgents,
    beginRun,
    beginMediaRun,
    updateMediaProgress,
    completeMediaRun,
    failMediaRun,
    beginCommerceRun,
    updateCommerceProgress,
    failCommerceRun,
    updateAgent,
    activateAgent,
    applyAgentEvent,
    applyLifecycleEvent,
    markFinalResponse,
    failRunningAgents,
    finalizeAgents,
  };
}

export type AgentCoordinator = ReturnType<typeof useAgentCoordinator>;
