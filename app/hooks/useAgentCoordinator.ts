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
  InteractiveRequest,
  StreamPacketType,
} from "../types/workspace";
import { createRunAgents, normalizeAgentKind } from "../utils/agentRuntime";

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
          if (interactiveRequest && agent.type === "terminal") {
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
    updateAgent,
    activateAgent,
    applyAgentEvent,
    markFinalResponse,
    failRunningAgents,
    finalizeAgents,
  };
}

export type AgentCoordinator = ReturnType<typeof useAgentCoordinator>;
