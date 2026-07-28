// 模块说明：负责 state 接口及服务端流程。
import type { BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";
import {
  createEmptyLongTermMemory,
  createEmptyShortTermMemory,
  createEmptyWorkingMemory,
} from "@/app/lib/agent-runtime/memory-types";
import type {
  LongTermMemorySnapshot,
  ShortTermMemorySnapshot,
  WorkingMemorySnapshot,
} from "@/app/lib/agent-runtime/memory-types";
import {
  DEFAULT_REFLECTION_PAYLOAD,
  type ReflectionDecision,
  type ReflectionPayload,
} from "@/app/lib/agent-runtime/reflection-types";
import {
  DEFAULT_HIGH_LEVEL_PLAN,
  DEFAULT_MERGE_RESULT,
  DEFAULT_PLANNER_PAYLOAD,
  DEFAULT_REVIEW_PAYLOAD,
  DEFAULT_VERIFICATION_RESULT,
  createDefaultWorkerMemory,
} from "./types";
import type {
  AgentLifecycleEvent,
  AgentLifecycleSnapshot,
  AgentRequestMode,
  HighLevelPlanPayload,
  InteractiveRequest,
  MergeResult,
  ModifyTaskResult,
  ModifyWorkerInput,
  PlannerPayload,
  PlannerValidationStatus,
  PlanTask,
  ReviewPayload,
  SharedWorkerMemory,
  VerificationResult,
  WorkerMemory,
  WorkspaceRuntimeInfo,
} from "./types";

const replaceValue = <T>(current: T, next: T | undefined): T =>
  next === undefined ? current : next;

/**
 * 主线程只保留最近 24 条消息。
 *
 * LangGraph 的 messagesStateReducer 仍负责消息 ID 覆盖与 RemoveMessage 语义，
 * 最后再截断窗口，既避免破坏框架行为，也防止长时间循环让 Checkpoint 无限增长。
 */
const MAX_MAIN_MESSAGES = 24;
const limitedMessagesReducer = (
  currentState: BaseMessage[],
  newValue: BaseMessage[] | undefined,
): BaseMessage[] => {
  if (newValue === undefined) return currentState;
  return messagesStateReducer(currentState, newValue).slice(-MAX_MAIN_MESSAGES);
};

/** 生命周期完整历史已写入 Trace SQLite；State 仅保留最近事件供 UI 即时展示。 */
const MAX_LIFECYCLE_EVENTS_IN_STATE = 200;

const mergeModifyResults = (
  currentState: ModifyTaskResult[],
  newValue: ModifyTaskResult[] | undefined,
): ModifyTaskResult[] => {
  if (newValue === undefined) return currentState;
  if (newValue.length === 0) return [];

  const resultMap = new Map(currentState.map((item) => [item.slot, item]));
  newValue.forEach((item) => resultMap.set(item.slot, item));
  return Array.from(resultMap.values()).sort(
    (left, right) => left.slot - right.slot,
  );
};

const mergeLifecycleSnapshots = (
  currentState: Record<string, AgentLifecycleSnapshot>,
  newValue: Record<string, AgentLifecycleSnapshot> | undefined,
): Record<string, AgentLifecycleSnapshot> => {
  if (newValue === undefined) return currentState;
  if (Object.keys(newValue).length === 0) return {};

  const merged = { ...currentState };
  for (const [agentId, nextSnapshot] of Object.entries(newValue)) {
    const previous = merged[agentId];
    if (
      !previous ||
      Date.parse(nextSnapshot.updatedAt) >= Date.parse(previous.updatedAt)
    ) {
      merged[agentId] = nextSnapshot;
    }
  }
  return merged;
};

const mergeLifecycleEvents = (
  currentState: AgentLifecycleEvent[],
  newValue: AgentLifecycleEvent[] | undefined,
): AgentLifecycleEvent[] => {
  if (newValue === undefined) return currentState;
  if (newValue.length === 0) return [];

  const eventMap = new Map(currentState.map((event) => [event.id, event]));
  newValue.forEach((event) => eventMap.set(event.id, event));
  return Array.from(eventMap.values())
    .sort((left, right) => {
      const timeDiff = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return timeDiff !== 0 ? timeDiff : left.sequence - right.sequence;
    })
    .slice(-MAX_LIFECYCLE_EVENTS_IN_STATE);
};

/*
 * 主图共享状态。
 *
 * 隔离原则：
 * - messages 只保存用户主线程；
 * - Worker 通过 Send 获得自己的 task、previousMemory 与只读 SharedWorkerMemory；
 * - Worker 的 AI/Tool 消息不写入主图；
 * - 并发结果只通过带 reducer 的 modifyResults/lifecycle 字段汇总；
 * - 正式工作区只允许 Merge 节点统一写入。
 */
export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: limitedMessagesReducer,
    default: () => [],
  }),
  model: Annotation<string>,
  currentUserRequest: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  summary: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  searchContext: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  memoryContext: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  shortTermMemory: Annotation<ShortTermMemorySnapshot>({
    reducer: replaceValue,
    default: createEmptyShortTermMemory,
  }),
  workingMemory: Annotation<WorkingMemorySnapshot>({
    reducer: replaceValue,
    default: createEmptyWorkingMemory,
  }),
  longTermMemory: Annotation<LongTermMemorySnapshot>({
    reducer: replaceValue,
    default: createEmptyLongTermMemory,
  }),
  fileContext: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  mergedContext: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  requestMode: Annotation<AgentRequestMode>({
    reducer: replaceValue,
    default: () => "read_only",
  }),
  workspaceInfo: Annotation<WorkspaceRuntimeInfo | null>({
    reducer: replaceValue,
    default: () => null,
  }),
  directAnswer: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),

  // Hierarchical Planner 第一层。
  highLevelPlanRawOutput: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  highLevelPlan: Annotation<HighLevelPlanPayload>({
    reducer: replaceValue,
    default: () => DEFAULT_HIGH_LEVEL_PLAN,
  }),
  highLevelPlanSummary: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),

  // Hierarchical Planner 第二层：可并发叶子任务。
  plannerOutput: Annotation<PlannerPayload>({
    reducer: replaceValue,
    default: () => DEFAULT_PLANNER_PAYLOAD,
  }),
  plannerRawOutput: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  plannerValidationStatus: Annotation<PlannerValidationStatus>({
    reducer: replaceValue,
    default: () => "pending",
  }),
  plannerValidationMessage: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  plannerRetryCount: Annotation<number>({
    reducer: replaceValue,
    default: () => 0,
  }),
  plannerRetryReason: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  structuredTaskListSummary: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  requiresChanges: Annotation<boolean>({
    reducer: replaceValue,
    default: () => false,
  }),

  // Dynamic Send Worker 的并发聚合通道。
  modifyResults: Annotation<ModifyTaskResult[]>({
    reducer: mergeModifyResults,
    default: () => [],
  }),

  mergeResult: Annotation<MergeResult>({
    reducer: replaceValue,
    default: () => DEFAULT_MERGE_RESULT,
  }),
  mergedPatchSummary: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  reviewPayload: Annotation<ReviewPayload>({
    reducer: replaceValue,
    default: () => DEFAULT_REVIEW_PAYLOAD,
  }),
  reviewFeedback: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  reviewDecision: Annotation<string>({
    reducer: replaceValue,
    default: () => "PASS",
  }),
  retryTaskSlots: Annotation<number[]>({
    reducer: replaceValue,
    default: () => [],
  }),
  reviewIteration: Annotation<number>({
    reducer: replaceValue,
    default: () => 0,
  }),
  reflectionPayload: Annotation<ReflectionPayload>({
    reducer: replaceValue,
    default: () => DEFAULT_REFLECTION_PAYLOAD,
  }),
  reflectionDecision: Annotation<ReflectionDecision>({
    reducer: replaceValue,
    default: () => "ACCEPT",
  }),
  memoryConsolidationSummary: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  verificationResult: Annotation<VerificationResult>({
    reducer: replaceValue,
    default: () => DEFAULT_VERIFICATION_RESULT,
  }),
  lintSummary: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  finalReportSummary: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  /** 完整报告已外置到 Trace SQLite；State 只保存轻量引用，避免重复上下文。 */
  evaluationReportId: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  evaluationSummary: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  touchedFiles: Annotation<string[]>({
    reducer: replaceValue,
    default: () => [],
  }),
  interactiveRequest: Annotation<InteractiveRequest | null>({
    reducer: (_currentState, newValue) => newValue ?? null,
    default: () => null,
  }),
  /**
   * 当前用户任务中，已经通过 UI 明确允许新建的缺失文件。
   * 每个普通新任务都会在 Router 中清空，避免授权跨任务泄漏。
   */
  approvedMissingFiles: Annotation<string[]>({
    reducer: replaceValue,
    default: () => [],
  }),
  /** 当前任务已获用户批准的高风险操作令牌；Router 会在普通新任务时清空。 */
  approvedRiskActions: Annotation<string[]>({
    reducer: replaceValue,
    default: () => [],
  }),
  /** 风险审批恢复标志：为 true 时直接回到审批节点，不重复执行 Planner/Worker。 */
  resumeFromRiskApproval: Annotation<boolean>({
    reducer: replaceValue,
    default: () => false,
  }),
  approvalResumeTarget: Annotation<"" | "merge" | "worker">({
    reducer: replaceValue,
    default: () => "",
  }),

  // Lifecycle Snapshot 供 UI 快速读取当前状态，Events 供审计/时间线使用。
  agentLifecycles: Annotation<Record<string, AgentLifecycleSnapshot>>({
    reducer: mergeLifecycleSnapshots,
    default: () => ({}),
  }),
  agentLifecycleEvents: Annotation<AgentLifecycleEvent[]>({
    reducer: mergeLifecycleEvents,
    default: () => [],
  }),

  workingDir: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  projectId: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  tokenUsage: Annotation<{ prompt: number; completion: number; total: number }>({
    reducer: (currentState, newValue) => {
      if (!newValue) return currentState;
      return {
        prompt: currentState.prompt + (newValue.prompt || 0),
        completion: currentState.completion + (newValue.completion || 0),
        total: currentState.total + (newValue.total || 0),
      };
    },
    default: () => ({ prompt: 0, completion: 0, total: 0 }),
  }),
});

/*
 * Dynamic Send Worker 的独立输入 State。
 * 没有主线程 messages，避免跨 Worker ToolMessage 污染。
 */
export const ModifyWorkerState = Annotation.Root({
  workerId: Annotation<string>,
  slot: Annotation<number>,
  task: Annotation<PlanTask>,
  sharedMemory: Annotation<SharedWorkerMemory>,
  previousMemory: Annotation<WorkerMemory>({
    reducer: replaceValue,
    default: createDefaultWorkerMemory,
  }),
  previousResult: Annotation<ModifyTaskResult | null>({
    reducer: replaceValue,
    default: () => null,
  }),
  requestMode: Annotation<AgentRequestMode>({
    reducer: replaceValue,
    default: () => "code_change",
  }),
  approvedMissingFiles: Annotation<string[]>({
    reducer: replaceValue,
    default: () => [],
  }),
  /** 当前任务已获用户批准的高风险操作令牌；Router 会在普通新任务时清空。 */
  approvedRiskActions: Annotation<string[]>({
    reducer: replaceValue,
    default: () => [],
  }),
  /** 风险审批恢复标志：为 true 时直接回到审批节点，不重复执行 Planner/Worker。 */
  resumeFromRiskApproval: Annotation<boolean>({
    reducer: replaceValue,
    default: () => false,
  }),
  approvalResumeTarget: Annotation<"" | "merge" | "worker">({
    reducer: replaceValue,
    default: () => "",
  }),
  model: Annotation<string>,
  workingDir: Annotation<string>,
  projectId: Annotation<string>,
  reviewFeedback: Annotation<string>({
    reducer: replaceValue,
    default: () => "",
  }),
  reviewIteration: Annotation<number>({
    reducer: replaceValue,
    default: () => 0,
  }),
  interactiveRequest: Annotation<InteractiveRequest | null>({
    reducer: (_currentState, newValue) => newValue ?? null,
    default: () => null,
  }),
  modifyResults: Annotation<ModifyTaskResult[]>({
    reducer: mergeModifyResults,
    default: () => [],
  }),
  agentLifecycles: Annotation<Record<string, AgentLifecycleSnapshot>>({
    reducer: mergeLifecycleSnapshots,
    default: () => ({}),
  }),
  agentLifecycleEvents: Annotation<AgentLifecycleEvent[]>({
    reducer: mergeLifecycleEvents,
    default: () => [],
  }),
  tokenUsage: Annotation<{ prompt: number; completion: number; total: number }>({
    reducer: (currentState, newValue) => {
      if (!newValue) return currentState;
      return {
        prompt: currentState.prompt + (newValue.prompt || 0),
        completion: currentState.completion + (newValue.completion || 0),
        total: currentState.total + (newValue.total || 0),
      };
    },
    default: () => ({ prompt: 0, completion: 0, total: 0 }),
  }),
});

export type ModifyWorkerStateInput = ModifyWorkerInput;
