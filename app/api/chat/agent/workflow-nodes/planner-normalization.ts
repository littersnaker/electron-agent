/**
 * 模块职责：计划归一化、重试状态与修改结果格式化。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */

import type { AgentLifecycleEvent, AgentLifecycleSnapshot, InteractiveRequest, ModifyTaskResult, PlannerPayload, PlanTask, WorkerFileChange, WorkerMemory } from "../types";
import { type AgentRuntimeState, MAX_PARALLEL_MODIFIERS, MAX_PLANNER_RETRIES, getLatestUserRequest } from "./runtime-lifecycle";
// 规则修复阶段用这个函数做“保守去重”：
// 同一个文件只保留给最先命中的任务，后面的任务自动剔除该文件。
export function normalizePlannerTasks(tasks: PlannerPayload): PlannerPayload {
  const seenFiles = new Set<string>();

  return tasks
    .map((task) => {
      const uniqueFiles = task.files.filter((file) => {
        const normalizedFile = file.toLowerCase();
        if (seenFiles.has(normalizedFile)) return false;
        seenFiles.add(normalizedFile);
        return true;
      });
      return {
        ...task,
        files: uniqueFiles,
      };
    })
    .filter((task) => task.task.trim() && task.files.length > 0)
    .slice(0, MAX_PARALLEL_MODIFIERS);
}

// 当 Planner 反复失败时，就不再坚持并发拆分。
// 这里会把任务退化成一个“大而全”的单任务，交给单 Agent 串行处理。
export function buildSingleAgentFallbackPlan(state: AgentRuntimeState): PlannerPayload {
  const collectedFiles = [
    ...(state.plannerOutput || []).flatMap((task: { files: string[] }) => task.files),
    ...extractCandidatePaths(getLatestUserRequest(state)),
    ...extractCandidatePaths(state.mergedContext || ""),
  ];
  const uniqueFiles = Array.from(
    new Set(collectedFiles.map((file) => file.trim()).filter(Boolean)),
  ).slice(0, 12);

  return [
    {
      id: "fallback_single_agent",
      parentId: "fallback",
      task: `单 Agent 降级执行：${getLatestUserRequest(state)}`,
      files: uniqueFiles,
      reason: "Planner 多次无法生成安全的并发任务，降级为单 Worker 串行处理。",
      acceptanceCriteria: ["在单个 Worker 内完成用户需求并通过统一 Review"],
      priority: "high",
    },
  ];
}

// 统一判断 Planner 还能不能继续重试，以及下一次的重试计数是多少。
export function getPlannerRetryStatus(state: AgentRuntimeState): {
  shouldRetry: boolean;
  nextRetryCount: number;
} {
  const currentRetryCount = state.plannerRetryCount || 0;
  if (currentRetryCount >= MAX_PLANNER_RETRIES) {
    return { shouldRetry: false, nextRetryCount: currentRetryCount };
  }

  return {
    shouldRetry: true,
    nextRetryCount: currentRetryCount + 1,
  };
}

// 把 Reviewer 指定的槽位数组格式化成人能一眼看懂的字符串。
export function formatRetryTasks(retryTasks: number[]): string {
  if (!retryTasks.length) return "无";
  return retryTasks.map((slot) => `Task ${slot + 1}`).join(", ");
}

// Reviewer 没给明确 retryTasks 时，给一个尽量安全的兜底策略。
// 当前做法是：优先回退到已有 done 结果里的某个槽位，至少保证返工目标不为空。
export function resolveRetryTaskSlots(state: AgentRuntimeState): number[] {
  const validRetryTasks = (state.reviewPayload?.retryTasks || [])
    .filter((value: number) => Number.isInteger(value))
    .filter((value: number) => value >= 0 && value < MAX_PARALLEL_MODIFIERS);

  if (validRetryTasks.length) {
    return Array.from(new Set(validRetryTasks));
  }

  const fallbackSlot = (state.modifyResults || []).find(
    (item: ModifyTaskResult) =>
      item.status === "done" || item.status === "satisfied",
  )?.slot;

  return fallbackSlot === undefined ? [] : [fallbackSlot];
}

// 从用户请求里尽量抓出“像路径一样的字符串”。
// FileAgent 会拿这份候选路径去预读文件或目录。
export function extractCandidatePaths(input: string): string[] {
  const matches =
    input.match(
      /[A-Za-z]:\\[^\s"'`]+|(?:\.{0,2}[\\/])?[A-Za-z0-9_\-./\\]+\.[A-Za-z0-9]+/g,
    ) || [];

  return Array.from(
    new Set(
      matches
        .map((item) => item.replace(/[),.;:]+$/, "").trim())
        .filter((item) => item.length > 1 && !item.startsWith("http")),
    ),
  );
}

// 把单个并发 Worker 的执行结果收敛成统一结构。
export function buildModifyResult(
  workerId: string,
  slot: number,
  task: PlanTask,
  summary: string,
  status: ModifyTaskResult["status"],
  fileChanges: WorkerFileChange[],
  workerMemory: WorkerMemory,
  lifecycle: AgentLifecycleSnapshot,
  lifecycleEvents: AgentLifecycleEvent[],
  interactiveRequest: InteractiveRequest | null = null,
): ModifyTaskResult {
  return {
    workerId,
    slot,
    task: task.task,
    taskId: task.id,
    files: task.files,
    summary,
    touchedFiles: Array.from(
      new Set(fileChanges.map((change) => change.filePath)),
    ),
    fileChanges,
    workerMemory,
    lifecycle,
    lifecycleEvents,
    interactiveRequest,
    status,
  };
}

// 给 Merge、Reviewer、Final Report 提供统一的人类可读结果文本。
export function formatModifyResults(results: ModifyTaskResult[]): string {
  if (!results.length) return "暂无 Modify Worker 结果。";

  return [...results]
    .sort((left, right) => left.slot - right.slot)
    .map((result) => {
      const readyCount = result.fileChanges.filter((item) => item.ready).length;
      return [
        `Worker: ${result.workerId}`,
        `槽位 ${result.slot + 1}: ${result.task}`,
        `状态: ${result.status}`,
        `计划文件: ${result.files.length ? result.files.join(", ") : "未指定"}`,
        `实际提案: ${result.touchedFiles.length ? result.touchedFiles.join(", ") : "无"}`,
        `待合并变更: ${readyCount}/${result.fileChanges.length}`,
        `Memory 压缩次数: ${result.workerMemory.compressionCount}`,
        `生命周期: ${result.lifecycle.status}`,
        `总结: ${result.summary}`,
      ].join("\n");
    })
    .join("\n\n");
}
