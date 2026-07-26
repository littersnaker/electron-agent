// 模块说明：负责 types 接口及服务端流程。
/*
 * Multi-agent Agent Runtime 的公共结构定义。
 *
 * V3 重点：
 * 1. Hierarchical Planner：High-Level Plan -> Parallel Leaf Tasks；
 * 2. Dynamic Worker：Planner 有几个独立任务就启动几个 Send Worker；
 * 3. Worker Memory Compression：Worker 自己压缩上下文，不污染主线程；
 * 4. Patch Manager：Merge 支持相同输出去重、保守三方合并和冲突报告；
 * 5. Agent Lifecycle：统一记录 Planner / Worker / Merge / Review / Verify 生命周期。
 */

export type TaskPriority = "high" | "medium" | "low";

/**
 * Router 对当前用户请求的确定性分类。
 *
 * - workspace_info：只询问当前项目、目录或绑定信息；
 * - read_only：需要读取项目，但不允许修改文件；
 * - simple_edit：明确的单文件轻量修改，跳过重型 Planner；
 * - code_change：进入完整 Planner / Worker / Merge / Verify 链路。
 */
export type AgentRequestMode =
  | "workspace_info"
  | "read_only"
  | "simple_edit"
  | "code_change";

/** 当前 Code 会话绑定的本地工作区信息。 */
export interface WorkspaceRuntimeInfo {
  projectId: string;
  folderName: string;
  rootPath: string;
  pathExists: boolean;
  isDirectory: boolean;
}

/** High-Level Planner 产出的业务工作流/模块级计划。 */
export interface HighLevelPlanItem {
  id: string;
  objective: string;
  scope: string[];
  rationale: string;
  dependencies: string[];
  priority: TaskPriority;
}

export type HighLevelPlanPayload = HighLevelPlanItem[];
export const DEFAULT_HIGH_LEVEL_PLAN: HighLevelPlanPayload = [];

/** Task Planner 产出的、可以安全并发执行的叶子任务。 */
export interface PlanTask {
  id: string;
  parentId: string;
  task: string;
  files: string[];
  reason: string;
  acceptanceCriteria: string[];
  priority: TaskPriority;
}

export type PlannerPayload = PlanTask[];
export const DEFAULT_PLANNER_PAYLOAD: PlannerPayload = [];

export type PlannerValidationStatus =
  | "pending"
  | "schema_valid"
  | "schema_invalid"
  | "files_unique"
  | "files_duplicated"
  | "rules_repaired"
  | "single_agent_degraded";

export type CommandExecutionMode = "normal" | "pty";
export type InteractiveResponseMode = "auto" | "llm" | "user" | "cancel";
export type InteractiveRequestSource =
  | "terminal"
  | "file_create_confirmation"
  | "risk_approval"
  | "mcp_tool_approval";
export type InteractivePromptKind =
  | "confirm"
  | "select"
  | "multiselect"
  | "input";

export type InteractiveTerminalStatus =
  | "idle"
  | "waiting"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface InteractiveOption {
  label: string;
  value: string;
  index: number;
  selected?: boolean;
  focused?: boolean;
}

export interface InteractiveRequest {
  /**
   * terminal 为现有 CLI 交互；file_create_confirmation 用于缺失文件新建确认。
   * 保持可选是为了兼容旧 checkpoint 中没有 source 的终端请求。
   */
  source?: InteractiveRequestSource;
  id: string;
  command: string;
  prompt: string;
  mode: CommandExecutionMode;
  kind: InteractivePromptKind;
  suggestedMode: InteractiveResponseMode;
  options: Array<{ label: string; value: string; index?: number }>;
  allowMultiple: boolean;
  promptRound: number;
  recentOutput: string;
  /** UI 卡片可选展示字段；终端请求无需提供。 */
  title?: string;
  /** 风险审批类别，供前端展示和 Router 恢复流程。 */
  approvalKind?: "workspace_write" | "mcp_tool";
  /** 风险等级仅用于解释，不直接替代服务端规则判断。 */
  riskLevel?: "medium" | "high";
  /** 被审批的工具名或 Merge 操作名。 */
  toolName?: string;
  /** 只保存经过截断和脱敏的参数预览，不能保存密钥。 */
  toolArguments?: Record<string, unknown>;
  /** 服务端生成的稳定授权令牌，批准后写入本轮 State。 */
  approvalToken?: string;
  description?: string;
  filePath?: string;
  /**
   * 缺失文件确认后需要恢复用户的原始任务，避免把内部回复文本送进 Planner。
   */
  originalUserRequest?: string;
  workerId?: string;
  slot?: number;
}

export interface InteractiveReply {
  requestId: string;
  mode: InteractiveResponseMode;
  answer?: string;
  selectedValue?: string;
  selectedValues?: string[];
}

/** Worker 可以共享，但不能修改的主图 Memory。 */
export interface SharedWorkerMemory {
  latestUserRequest: string;
  summary: string;
  mergedContext: string;
  structuredTaskListSummary: string;
  highLevelPlanSummary: string;
}

/** 单个 Worker 的压缩记忆；仅跟随该 Worker/slot，不进入主线程 messages。 */
export interface WorkerMemory {
  summary: string;
  completedActions: string[];
  pendingActions: string[];
  keyFiles: string[];
  recentObservations: string[];
  compressionCount: number;
  lastCompressedRound: number;
}

export function createDefaultWorkerMemory(): WorkerMemory {
  return {
    summary: "",
    completedActions: [],
    pendingActions: [],
    keyFiles: [],
    recentObservations: [],
    compressionCount: 0,
    lastCompressedRound: 0,
  };
}

/** Dynamic Send 给单个 Worker 的独立输入。 */
export interface ModifyWorkerInput {
  workerId: string;
  slot: number;
  task: PlanTask;
  sharedMemory: SharedWorkerMemory;
  previousMemory: WorkerMemory;
  /**
   * 上一轮同槽位的完整结果。
   * Reviewer 返工时用它判断“目标内容是否已经落盘”，避免 no-op 被误判为失败。
   */
  previousResult: ModifyTaskResult | null;
  requestMode: AgentRequestMode;
  /** 用户在 UI 中已明确允许创建的缺失文件。 */
  approvedMissingFiles: string[];
  /** 当前任务已由用户批准的风险操作令牌。 */
  approvedRiskActions: string[];
  model: string;
  workingDir: string;
  projectId: string;
  reviewFeedback: string;
  reviewIteration: number;
  interactiveRequest: InteractiveRequest | null;
}

export type AgentRole =
  | "router"
  | "search_agent"
  | "memory_agent"
  | "file_agent"
  | "context_merge"
  | "high_level_planner"
  | "task_planner"
  | "modify_worker"
  | "merge_agent"
  | "reviewer_agent"
  | "verification_agent"
  | "final_report_agent";

export type AgentLifecycleStatus =
  | "CREATED"
  | "PLANNING"
  | "EXECUTING"
  | "WAITING_TOOL"
  | "COMPRESSING"
  | "READY_TO_MERGE"
  | "MERGING"
  | "REVIEWING"
  | "VERIFYING"
  | "BLOCKED"
  | "COMPLETED"
  | "FAILED";

export interface AgentLifecycleEvent {
  id: string;
  agentId: string;
  role: AgentRole;
  status: AgentLifecycleStatus;
  previousStatus?: AgentLifecycleStatus;
  slot?: number;
  iteration: number;
  sequence: number;
  detail: string;
  toolName?: string;
  createdAt: string;
}

export interface AgentLifecycleSnapshot {
  agentId: string;
  role: AgentRole;
  status: AgentLifecycleStatus;
  slot?: number;
  iteration: number;
  detail: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  failedAt?: string;
}

export interface AgentLifecycleStreamPayload {
  type: "AGENT_LIFECYCLE";
  payload: AgentLifecycleEvent;
}

export type WorkerMergeStrategy =
  | "single"
  | "identical_deduplicated"
  | "three_way_disjoint";

/** Worker 在独立内存区生成、等待 Merge 统一落盘的完整文件提案。 */
export interface WorkerFileChange {
  workerId: string;
  slot: number;
  filePath: string;
  baseExists: boolean;
  baseContent: string | null;
  baseContentHash: string;
  proposedContentHash: string;
  proposedContent: string;
  ready: boolean;
  sourceWorkerIds: string[];
  sourceSlots: number[];
  mergeStrategy: WorkerMergeStrategy;
}

export interface ModifyTaskResult {
  workerId: string;
  slot: number;
  task: string;
  taskId: string;
  files: string[];
  summary: string;
  touchedFiles: string[];
  fileChanges: WorkerFileChange[];
  workerMemory: WorkerMemory;
  lifecycle: AgentLifecycleSnapshot;
  lifecycleEvents: AgentLifecycleEvent[];
  interactiveRequest?: InteractiveRequest | null;
  status:
    | "pending"
    | "done"
    | "satisfied"
    | "skipped"
    | "blocked"
    | "failed";
}

export type MergeConflictType =
  | "same_file"
  | "overlapping_patch"
  | "base_mismatch"
  | "workspace_changed"
  | "worker_failed"
  | "invalid_patch"
  | "apply_failed";

export interface MergeConflict {
  type: MergeConflictType;
  filePath?: string;
  workerIds: string[];
  slots: number[];
  message: string;
}

export type MergeStatus =
  | "pending"
  | "success"
  | "conflict"
  | "blocked"
  | "failed";

export interface MergeResult {
  status: MergeStatus;
  appliedFiles: string[];
  alreadyAppliedFiles: string[];
  autoMergedFiles: string[];
  deduplicatedFiles: string[];
  skippedFiles: string[];
  conflicts: MergeConflict[];
  summary: string;
}

export const DEFAULT_MERGE_RESULT: MergeResult = {
  status: "pending",
  appliedFiles: [],
  alreadyAppliedFiles: [],
  autoMergedFiles: [],
  deduplicatedFiles: [],
  skippedFiles: [],
  conflicts: [],
  summary: "尚未执行并发变更合并。",
};

export type VerificationStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "blocked";

export interface VerificationCheckResult {
  status: VerificationStatus;
  command: string | null;
  output: string;
}

export type VerificationProfile = "none" | "document" | "targeted" | "full";

export interface VerificationResult {
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | "unknown";
  /**
   * document 只检查文档是否已落盘，不运行项目级 build/test；
   * targeted/full 保留代码任务的工程校验能力。
   */
  profile: VerificationProfile;
  lint: VerificationCheckResult;
  build: VerificationCheckResult;
  test: VerificationCheckResult;
  overall: VerificationStatus;
  summary: string;
}

export const DEFAULT_VERIFICATION_RESULT: VerificationResult = {
  packageManager: "unknown",
  profile: "none",
  lint: { status: "skipped", command: null, output: "尚未执行 lint。" },
  build: { status: "skipped", command: null, output: "尚未执行 build。" },
  test: { status: "skipped", command: null, output: "尚未执行 test。" },
  overall: "skipped",
  summary: "尚未执行工程验证。",
};

export interface ReviewPayload {
  decision: "PASS" | "RETRY" | "FAIL";
  feedback: string;
  risks: string[];
  retryTasks: number[];
}

export const DEFAULT_REVIEW_PAYLOAD: ReviewPayload = {
  decision: "PASS",
  feedback: "",
  risks: [],
  retryTasks: [],
};

export function formatHighLevelPlan(plan: HighLevelPlanPayload): string {
  if (!plan.length) return "暂无高层计划。";
  return plan
    .map(
      (item, index) =>
        `${index + 1}. [${item.id}] ${item.objective}\n范围: ${
          item.scope.length ? item.scope.join(", ") : "未指定"
        }\n依赖: ${item.dependencies.length ? item.dependencies.join(", ") : "无"}`,
    )
    .join("\n\n");
}

export function formatPlannerPayload(plan: PlannerPayload): string {
  if (!plan.length) return "暂无计划任务。";

  return plan
    .map(
      (item, index) =>
        `${index + 1}. [${item.id}] ${item.task}\n父计划: ${item.parentId}\n文件: ${
          item.files.length ? item.files.join(", ") : "未指定"
        }\n验收: ${
          item.acceptanceCriteria.length
            ? item.acceptanceCriteria.join("；")
            : "未指定"
        }`,
    )
    .join("\n\n");
}
