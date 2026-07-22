/*
 * 白雪条 Agent Runtime 的公共结构定义。
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
 * - code_change：进入 Planner / Worker / Merge / Verify 完整链路。
 */
export type AgentRequestMode =
  | "workspace_info"
  | "read_only"
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
  model: string;
  workingDir: string;
  projectId: string;
  apiKey: string;
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
  status: "pending" | "done" | "skipped" | "blocked" | "failed";
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

export interface VerificationResult {
  packageManager: "pnpm" | "npm" | "yarn" | "bun" | "unknown";
  lint: VerificationCheckResult;
  build: VerificationCheckResult;
  test: VerificationCheckResult;
  overall: VerificationStatus;
  summary: string;
}

export const DEFAULT_VERIFICATION_RESULT: VerificationResult = {
  packageManager: "unknown",
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
