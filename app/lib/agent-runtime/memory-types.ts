/**
 * 三层记忆系统的公共类型。
 *
 * 设计原则：
 * - 短期记忆只保存最近对话，不写入数据库；
 * - 工作记忆保存当前任务执行状态，由 LangGraph Checkpoint 管理；
 * - 长期记忆保存可复用的项目经验，写入项目级 SQLite。
 */

export type MemoryLayer = "short_term" | "working" | "long_term";

export type LongTermMemoryCategory =
  | "preference"
  | "constraint"
  | "architecture"
  | "decision"
  | "lesson";

export type WorkingMemoryPhase =
  | "idle"
  | "context"
  | "planning"
  | "executing"
  | "merging"
  | "verifying"
  | "reflecting"
  | "completed"
  | "failed";

/** 三层记忆统一使用的最小条目结构。 */
export interface LayeredMemoryItem {
  id: string;
  layer: MemoryLayer;
  content: string;
  category: LongTermMemoryCategory | "conversation" | "task_state";
  importance: number;
  createdAt: string;
  updatedAt: string;
  lastAccessedAt?: string;
  accessCount: number;
}

/** 近期对话窗口。内容可以随本轮结束而自然淘汰。 */
export interface ShortTermMemorySnapshot {
  items: LayeredMemoryItem[];
  maxItems: number;
  updatedAt: string;
}

/**
 * 当前任务的结构化执行状态。
 *
 * 该结构不保存大段源码和完整工具输出，只保留后续节点真正需要的目标、任务、事实和风险。
 */
export interface WorkingMemorySnapshot {
  goal: string;
  phase: WorkingMemoryPhase;
  activeTaskIds: string[];
  completedTaskIds: string[];
  pendingTaskIds: string[];
  keyFacts: string[];
  risks: string[];
  iteration: number;
  updatedAt: string;
}

/** 当前请求实际加载到主图中的长期记忆视图。 */
export interface LongTermMemorySnapshot {
  items: LayeredMemoryItem[];
  selectedIds: string[];
  updatedAt: string;
}

export function createEmptyShortTermMemory(): ShortTermMemorySnapshot {
  return {
    items: [],
    maxItems: 12,
    updatedAt: new Date(0).toISOString(),
  };
}

export function createEmptyWorkingMemory(
  goal = "",
): WorkingMemorySnapshot {
  return {
    goal,
    phase: goal ? "context" : "idle",
    activeTaskIds: [],
    completedTaskIds: [],
    pendingTaskIds: [],
    keyFacts: [],
    risks: [],
    iteration: 0,
    updatedAt: new Date(0).toISOString(),
  };
}

export function createEmptyLongTermMemory(): LongTermMemorySnapshot {
  return {
    items: [],
    selectedIds: [],
    updatedAt: new Date(0).toISOString(),
  };
}

/** 约束所有分值都处在 0~1，避免数据库脏值影响排序。 */
export function clampMemoryImportance(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1, Math.max(0, value));
}
