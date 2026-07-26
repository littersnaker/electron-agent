// 模块说明：负责 useAgentCoordinator 状态管理与业务编排。
"use client";

import { useMemo, useState } from "react";
import { createIdleAgents } from "../components/AgentPanel";
import type { AgentInstance } from "../components/AgentPanel";
import { useCommerceAgentActions } from "./agent-coordinator/commerce-agent-actions";
import { useGeneralAgentActions } from "./agent-coordinator/general-agent-actions";
import { useMediaAgentActions } from "./agent-coordinator/media-agent-actions";

/**
 * 统一协调右侧 Agent 面板状态。
 * 不同业务域的动作拆分到独立 Hook，主入口只负责组合公共状态和公开接口。
 */
export function useAgentCoordinator() {
  const [agents, setAgents] = useState<AgentInstance[]>(() => createIdleAgents());

  const runningAgentCount = useMemo(
    () =>
      agents.filter((agent) =>
        ["running", "thinking"].includes(agent.status),
      ).length,
    [agents],
  );

  const generalActions = useGeneralAgentActions(setAgents);
  const mediaActions = useMediaAgentActions(setAgents);
  const commerceActions = useCommerceAgentActions(setAgents);

  return {
    agents,
    runningAgentCount,
    ...generalActions,
    ...mediaActions,
    ...commerceActions,
  };
}

export type AgentCoordinator = ReturnType<typeof useAgentCoordinator>;
