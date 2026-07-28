// 模块说明：维护 workspace 共享类型定义。
import type { AgentKind, AgentStatus } from "../components/AgentPanel";
import type { ChatSession, WorkspaceProject } from "../constants/page-constants";
import type { CommerceProgressEvent, CommerceResearchReport } from "../lib/commerce/types";
import type { AmazonListingDemoReport } from "../lib/commerce/listing/types";

export interface WorkspaceResponse {
  projects: WorkspaceProject[];
  sessions: ChatSession[];
}

export type InteractiveRequestSource =
  | "terminal"
  | "file_create_confirmation"
  | "risk_approval"
  | "mcp_tool_approval";

export interface InteractiveRequest {
  id: string;
  /** 旧 checkpoint 的终端请求可能没有 source，因此保持可选兼容。 */
  source?: InteractiveRequestSource;
  command: string;
  prompt: string;
  mode: "normal" | "pty";
  suggestedMode: "auto" | "llm" | "user";
  kind?: "confirm" | "select" | "multiselect" | "input";
  allowMultiple?: boolean;
  options: Array<{ label: string; value: string }>;
  promptRound: number;
  recentOutput: string;
  title?: string;
  description?: string;
  filePath?: string;
  originalUserRequest?: string;
  approvalKind?: "workspace_write" | "mcp_tool";
  riskLevel?: "medium" | "high";
  toolName?: string;
  toolArguments?: Record<string, unknown>;
  approvalToken?: string;
  workerId?: string;
  slot?: number;
}

export interface ToolActivity {
  id: string;
  label: string;
  status: "running" | "completed" | "error";
  startedAt: number;
  endedAt?: number;
  /** 当前阶段的实时说明；任务规划可直接展示，不再回退到通用文案。 */
  detail?: string;
  /** 工作流提供的稳定阶段 ID；任务规划优先按该字段匹配，避免依赖展示文案。 */
  stageId?: string;
}

export interface TokenInfo {
  prompt: number;
  completion: number;
  total: number;
  /** tokens / images / videos / requests。 */
  unit?: "tokens" | "images" | "videos" | "requests";
  /** 媒体任务显示“图片额度/视频额度”，文本任务默认显示 Tokens。 */
  label?: string;
  /** 视觉质量检查等辅助 LLM 的 Token 消耗。 */
  auxiliaryPrompt?: number;
  auxiliaryCompletion?: number;
  auxiliaryTotal?: number;
  auxiliaryLabel?: string;
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

/**
 * 后端 LangGraph 节点直接上报的真实生命周期事件。
 *
 * 与旧 AGENT_* 事件不同，这个结构包含 role + iteration，
 * 因此前端可以正确展示 Reviewer -> Worker 的返工回环。
 */
export interface AgentLifecycleEventPayload {
  id: string;
  agentId: string;
  role: string;
  status: string;
  previousStatus?: string;
  slot?: number;
  iteration: number;
  sequence?: number;
  detail: string;
  toolName?: string;
  createdAt: string;
}

export type StreamPacketType =
  | "TEXT"
  | "STATUS"
  | "TOOL_STATUS"
  | "USAGE"
  | "INTERACTIVE_REQUEST"
  | "AGENT_LIFECYCLE"
  | "COMMERCE_PROGRESS"
  | "COMMERCE_REPORT"
  | "COMMERCE_LISTING"
  | "AGENT_START"
  | "AGENT_STATUS"
  | "AGENT_PROGRESS"
  | "AGENT_FINISH"
  | "AGENT_ERROR";

export interface StreamPacket {
  type?: StreamPacketType;
  content?: string | TokenInfo;
  payload?:
    | InteractiveRequest
    | AgentLifecycleEventPayload
    | CommerceProgressEvent
    | CommerceResearchReport
    | AmazonListingDemoReport;
  agent?: AgentEventPayload;
}
