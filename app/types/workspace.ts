// 模块说明：维护 workspace 共享类型定义。
import type { AgentKind, AgentStatus } from "../components/AgentPanel";
import type { ChatSession, MessageAttachment, WorkspaceProject } from "../constants/page-constants";
import type { CommerceProgressEvent, CommerceResearchReport } from "../lib/commerce/types";
import type { AmazonListingDemoReport } from "../lib/commerce/listing/types";

export interface WorkspaceResponse {
  projects: WorkspaceProject[];
  sessions: ChatSession[];
}

export type InteractiveRequestSource =
  "terminal" | "file_create_confirmation" | "risk_approval" | "mcp_tool_approval";

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
  currentFiles?: string[];
  createdAt: string;
}

export type WorkItemStatus = "pending" | "running" | "paused" | "succeeded" | "failed" | "skipped";

export interface WorkListItemPayload {
  id: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  dependencies: string[];
  priority?: number;
  targetFiles?: string[];
  serialGroup?: string;
  status: WorkItemStatus;
  attempts: number;
  summary: string;
  error: string;
  changedFiles: string[];
  commands: string[];
}

/** Code Agent 执行过程中的 Token 与 Work 状态指标。 */
export interface ExecutionMetricsPayload {
  totalTokens: number;
  activeTokens: number;
  compressedTokens: number;
  cleanedTokens: number;
  completedWorks: number;
  failedWorks: number;
  retryCount: number;
}

/** Patch、验证、回归和质量门的最终审查指标。 */
export interface ExecutionQualityPayload {
  changes: number;
  risk: "low" | "medium" | "high";
  riskScore: number;
  validationPassed: boolean;
  validationExecuted: boolean;
  regression: boolean;
  apiContractChanged: boolean;
  codeGatePassed: boolean;
  /** 质量分：五维加权（验证/风险/审核/过程/效率），无数据维度剔除归一化。 */
  qualityScore?: {
    score: number | null;
    dimensions: Record<string, number>;
    activeWeights: Record<string, number>;
  };
}

/** 本次会话的 LLM 性能指标聚合（TTFT / tok/s / token）。 */
export interface StepMetricsPayload {
  steps: number;
  avgTtftMs: number | null;
  avgTokPerSec: number | null;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCachedTokens: number;
}

/** Code Agent 后端提供的 WorkList 唯一真实快照。 */
export interface WorkListSnapshotPayload {
  revision: number;
  reason: string;
  total: number;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
  overallProgress: number;
  scheduler?: {
    mode: "dependency_graph" | string;
    maxParallel: number;
    activeWorkIds: string[];
  };
  metrics?: ExecutionMetricsPayload;
  quality?: ExecutionQualityPayload;
  stepMetrics?: StepMetricsPayload;
  items: WorkListItemPayload[];
}

export type StreamPacketType =
  | "TEXT"
  | "STATUS"
  | "TOOL_STATUS"
  | "USAGE"
  | "INTERACTIVE_REQUEST"
  | "AGENT_LIFECYCLE"
  | "WORKLIST_UPDATE"
  | "COMMERCE_PROGRESS"
  | "COMMERCE_REPORT"
  | "COMMERCE_LISTING"
  | "MEDIA_RESULT"
  | "IMAGE_RESULT"
  | "AGENT_START"
  | "AGENT_STATUS"
  | "AGENT_PROGRESS"
  | "AGENT_FINISH"
  | "AGENT_ERROR"
  | "VISUAL_VERIFY_REQUESTED"
  | "KNOWLEDGE_SOURCES";

/** 知识库检索命中的单个来源。 */
export interface KnowledgeSourceItem {
  /** 文档路径或 memory:scope:id 形式的来源标识 */
  sourcePath: string;
  /** doc / memory */
  sourceType: string;
  /** 来源内位置（如 PDF 的“第 3 页”），md/txt/docx 可能为空 */
  position?: string;
  /** 重排或向量相关度分数 */
  score?: number;
  /** 是否使用了父文本替换 */
  parentUsed?: boolean;
}

/** 知识库检索质量指标。 */
export interface KnowledgeMetrics {
  /** 配置的召回候选数 */
  recallK: number;
  /** 重排前的实际候选数 */
  candidateCount: number;
  /** 最终精排条数 */
  topK: number;
  /** 是否成功执行了重排 */
  reranked: boolean;
  /** 最终 Top-K 来源的平均相关度分数 */
  avgScore: number;
  /** 命中率：精排结果中正相关（分数≥0）来源的占比（0~1） */
  hitRate: number;
  /** 最终 Top-K 来源的最高相关度分数 */
  topScore: number;
}

/** 知识库来源广播事件的数据结构。 */
export interface KnowledgeSourcesPayload {
  sources: KnowledgeSourceItem[];
  count: number;
  searched: boolean;
  recallK: number;
  candidateCount: number;
  topK: number;
  reranked: boolean;
  avgScore: number;
  hitRate: number;
  topScore: number;
}

/** 视觉验证请求：前端需要启动预览、截图并用 GLM 核对页面渲染。 */
export interface VisualVerifyPayload {
  frontendChanged: string[];
  taskSummary?: string;
}

export interface StreamPacket {
  type?: StreamPacketType;
  content?: string | TokenInfo;
  payload?:
    | InteractiveRequest
    | AgentLifecycleEventPayload
    | WorkListSnapshotPayload
    | CommerceProgressEvent
    | CommerceResearchReport
    | AmazonListingDemoReport
    | VisualVerifyPayload
    | KnowledgeSourcesPayload
    | { content?: string; attachments?: MessageAttachment[] };
  agent?: AgentEventPayload;
}
