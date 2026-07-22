import type { AgentKind, AgentStatus } from "../component/AgentPanel";
import type { ChatSession, WorkspaceProject } from "../const/pageConst";

export interface WorkspaceResponse {
  projects: WorkspaceProject[];
  sessions: ChatSession[];
}

export interface InteractiveRequest {
  id: string;
  command: string;
  prompt: string;
  mode: "normal" | "pty";
  suggestedMode: "auto" | "llm" | "user";
  options: Array<{ label: string; value: string }>;
  promptRound: number;
  recentOutput: string;
}

export interface ToolActivity {
  id: string;
  label: string;
  status: "running" | "completed" | "error";
  startedAt: number;
  endedAt?: number;
}

export interface TokenInfo {
  prompt: number;
  completion: number;
  total: number;
}

export interface AgentEventPayload {
  id?: string;
  name?: string;
  type?: AgentKind | string;
  status?: AgentStatus;
  progress?: number;
  currentTask?: string;
  task?: string;
}

export type StreamPacketType =
  | "TEXT"
  | "STATUS"
  | "TOOL_STATUS"
  | "USAGE"
  | "INTERACTIVE_REQUEST"
  | "AGENT_START"
  | "AGENT_STATUS"
  | "AGENT_PROGRESS"
  | "AGENT_FINISH"
  | "AGENT_ERROR";

export interface StreamPacket {
  type?: StreamPacketType;
  content?: string | TokenInfo;
  payload?: InteractiveRequest;
  agent?: AgentEventPayload;
}
