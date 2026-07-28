/** Agent Reflection 的结构化输出。 */
import type { LongTermMemoryCategory } from "./memory-types";

export type ReflectionDecision = "ACCEPT" | "REVISE" | "STOP";

export interface ReflectionScores {
  requirementCoverage: number;
  correctness: number;
  verification: number;
  safety: number;
  maintainability: number;
}

/** 只有可跨任务复用的稳定事实才允许进入长期记忆候选。 */
export interface ReflectionMemoryCandidate {
  category: LongTermMemoryCategory;
  content: string;
  importance: number;
}

export interface ReflectionPayload {
  decision: ReflectionDecision;
  qualityScore: number;
  scores: ReflectionScores;
  diagnosis: string;
  lessons: string[];
  retryTasks: number[];
  memoryCandidates: ReflectionMemoryCandidate[];
}

export const DEFAULT_REFLECTION_SCORES: ReflectionScores = {
  requirementCoverage: 0,
  correctness: 0,
  verification: 0,
  safety: 0,
  maintainability: 0,
};

export const DEFAULT_REFLECTION_PAYLOAD: ReflectionPayload = {
  decision: "ACCEPT",
  qualityScore: 0,
  scores: DEFAULT_REFLECTION_SCORES,
  diagnosis: "尚未执行 Reflection。",
  lessons: [],
  retryTasks: [],
  memoryCandidates: [],
};
