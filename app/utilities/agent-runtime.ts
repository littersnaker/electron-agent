// 模块说明：提供 agent runtime 通用工具能力。
import { createIdleAgents } from "../components/AgentPanel";
import type { AgentInstance, AgentKind } from "../components/AgentPanel";
import type { Message, SessionMode, WorkspaceProject } from "../constants/page-constants";
import agentRoutingConfig from "../../config/agent-routing.json";

export const MAX_CONTEXT_MESSAGES = 24;

const AGENT_KIND_ALIASES = agentRoutingConfig.aliases as Record<string, AgentKind>;
const AGENT_INTENTS = agentRoutingConfig.intents as Array<{
  agent: AgentKind;
  keywords: string[];
}>;

export function buildWelcomeMessages(mode: SessionMode, project?: WorkspaceProject): Message[] {
  // 空会话的引导已由 ChatList 的 WelcomeHero 空态承担（问候 + 能力入口卡），
  // 不再往消息流里塞一条假的助手欢迎语；历史会话里的旧欢迎语保持原样展示。
  void mode;
  void project;
  return [];
}

export function normalizeAgentKind(value?: string): AgentKind {
  const normalized = (value || "").toLowerCase().replace(/[^a-z]/g, "");
  return AGENT_KIND_ALIASES[normalized] || "orchestrator";
}

export function inferAgentKind(text: string): AgentKind {
  const normalized = text.toLowerCase();

  for (const intent of AGENT_INTENTS) {
    if (intent.keywords.some((keyword) => normalized.includes(keyword.toLowerCase()))) {
      return intent.agent;
    }
  }

  return "orchestrator";
}

export function createRunAgents(): AgentInstance[] {
  const now = Date.now();

  return createIdleAgents().map((agent, index) => {
    // Media / Commerce 有独立工作流，普通 QA / Code 运行时保持空闲，避免误显示为等待角色。
    if (agent.type === "media" || agent.type === "commerce") {
      return { ...agent, updatedAt: now };
    }

    return {
      ...agent,
      status: agent.type === "orchestrator" ? "running" : "queued",
      progress: agent.type === "orchestrator" ? 8 : 0,
      currentTask:
        agent.type === "orchestrator"
          ? "分析请求并编排协作流程"
          : index === 1
            ? "等待 Orchestrator 分配规划任务"
            : "等待上游 Agent 完成",
      updatedAt: now,
    };
  });
}
