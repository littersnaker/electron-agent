/**
 * 模块职责：高层计划与任务计划的结构化解析和校验。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */

import { DEFAULT_HIGH_LEVEL_PLAN, DEFAULT_PLANNER_PAYLOAD, DEFAULT_REVIEW_PAYLOAD, type HighLevelPlanPayload, type PlannerPayload, type ReviewPayload } from "../types";
import { MAX_PARALLEL_MODIFIERS, highLevelPlanSchema, plannerPayloadSchema } from "./runtime-lifecycle";
// Planner 经常会在 JSON 外面夹带解释文字。
// 这里会尽量从整段文本里捞出第一个数组，给后续 schema 校验使用。
export function extractPlannerJsonArray(content: string): unknown | null {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const arrayMatch = trimmed.match(/\[[\s\S]*\]/);
  if (arrayMatch) candidates.push(arrayMatch[0]);

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
  }

  return null;
}

/*
 * 这是 Planner 的第一道门：
 * 先判断它是不是合法 JSON，
 * 再判断这个 JSON 是否满足我们定义的任务数组 schema。
 *
 * 只有通过这里，后面的并发 Modify 才有意义。
 */

export function findHighLevelDependencyCycle(
  plan: HighLevelPlanPayload,
): string[] | null {
  const dependencies = new Map(
    plan.map((item) => [item.id, item.dependencies]),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    if (visiting.has(id)) {
      const cycleStart = stack.indexOf(id);
      return [...stack.slice(cycleStart), id];
    }
    if (visited.has(id)) return null;

    visiting.add(id);
    stack.push(id);
    for (const dependency of dependencies.get(id) || []) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  };

  for (const item of plan) {
    const cycle = visit(item.id);
    if (cycle) return cycle;
  }
  return null;
}

export function parseHighLevelPlanWithSchema(content: string): {
  success: boolean;
  plan: HighLevelPlanPayload;
  message: string;
} {
  const extracted = extractPlannerJsonArray(content);
  if (extracted === null) {
    return {
      success: false,
      plan: DEFAULT_HIGH_LEVEL_PLAN,
      message: "High-Level Planner 输出中未提取到合法 JSON 数组。",
    };
  }

  const parsed = highLevelPlanSchema.safeParse(extracted);
  if (!parsed.success) {
    return {
      success: false,
      plan: DEFAULT_HIGH_LEVEL_PLAN,
      message: `High-Level Plan Schema 校验失败: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    };
  }

  const ids = new Set(parsed.data.map((item) => item.id.trim()));
  const duplicatedIds = parsed.data
    .map((item) => item.id.trim())
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicatedIds.length) {
    return {
      success: false,
      plan: DEFAULT_HIGH_LEVEL_PLAN,
      message: `High-Level Plan 存在重复 id: ${Array.from(
        new Set(duplicatedIds),
      ).join(", ")}`,
    };
  }

  const invalidDependency = parsed.data.find((item) =>
    item.dependencies.some((dependency) => !ids.has(dependency)),
  );
  if (invalidDependency) {
    return {
      success: false,
      plan: DEFAULT_HIGH_LEVEL_PLAN,
      message: `High-Level Plan 的依赖引用无效: ${invalidDependency.id}`,
    };
  }

  const plan = parsed.data.map((item) => ({
    id: item.id.trim(),
    objective: item.objective.trim(),
    scope: item.scope.map((value) => value.trim()).filter(Boolean),
    rationale: item.rationale.trim(),
    dependencies: item.dependencies.map((value) => value.trim()).filter(Boolean),
    priority: item.priority,
  }));
  const dependencyCycle = findHighLevelDependencyCycle(plan);
  if (dependencyCycle) {
    return {
      success: false,
      plan: DEFAULT_HIGH_LEVEL_PLAN,
      message: `High-Level Plan 存在循环依赖: ${dependencyCycle.join(" -> ")}`,
    };
  }

  return {
    success: true,
    plan,
    message: plan.length
      ? "High-Level Plan Schema 校验通过。"
      : "High-Level Planner 判断当前请求无需代码修改。",
  };
}

export function parsePlannerPayloadWithSchema(
  content: string,
  highLevelPlan: HighLevelPlanPayload,
): {
  success: boolean;
  tasks: PlannerPayload;
  message: string;
} {
  const extracted = extractPlannerJsonArray(content);
  if (extracted === null) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: "Task Planner 输出中未提取到合法 JSON 数组。",
    };
  }

  const parsedResult = plannerPayloadSchema.safeParse(extracted);
  if (!parsedResult.success) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: `Task Planner JSON Schema 校验失败: ${parsedResult.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    };
  }

  if (parsedResult.data.length === 0) {
    return {
      success: true,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: "Task Planner Schema 校验通过，当前请求无需拆分修改任务。",
    };
  }

  const highLevelIds = new Set(highLevelPlan.map((item) => item.id));
  if (highLevelIds.size === 0) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: "High-Level Plan 为空，但 Task Planner 返回了修改任务。",
    };
  }

  const normalizedTasks = parsedResult.data.map((task) => ({
    id: task.id.trim(),
    parentId: task.parentId.trim(),
    task: task.task.trim(),
    files: Array.from(
      new Set(task.files.map((file) => file.trim()).filter(Boolean)),
    ),
    reason: task.reason.trim(),
    acceptanceCriteria: task.acceptanceCriteria
      .map((item) => item.trim())
      .filter(Boolean),
    priority: task.priority,
  }));

  const duplicatedTaskIds = normalizedTasks
    .map((task) => task.id)
    .filter((id, index, all) => all.indexOf(id) !== index);
  if (duplicatedTaskIds.length) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: `Task Planner 存在重复任务 id: ${Array.from(
        new Set(duplicatedTaskIds),
      ).join(", ")}`,
    };
  }

  const invalidParent = normalizedTasks.find(
    (task) =>
      task.parentId !== "fallback" &&
      highLevelIds.size > 0 &&
      !highLevelIds.has(task.parentId),
  );
  if (invalidParent) {
    return {
      success: false,
      tasks: DEFAULT_PLANNER_PAYLOAD,
      message: `Task Planner 的 parentId 无法对应 High-Level Plan: ${invalidParent.id}`,
    };
  }

  return {
    success: true,
    tasks: normalizedTasks.slice(0, MAX_PARALLEL_MODIFIERS),
    message: "Task Planner JSON Schema 校验通过。",
  };
}

// 并发 Modify 最怕多个任务改同一个文件。
// 这个函数专门找出跨任务重复文件，给“文件唯一性检查”节点使用。
export function collectDuplicatePlannerFiles(tasks: PlannerPayload): string[] {
  const seenFiles = new Set<string>();
  const duplicatedFiles = new Set<string>();

  tasks.forEach((task) => {
    task.files.forEach((file) => {
      const normalizedFile = file.toLowerCase();
      if (seenFiles.has(normalizedFile)) {
        duplicatedFiles.add(file);
        return;
      }
      seenFiles.add(normalizedFile);
    });
  });

  return Array.from(duplicatedFiles);
}

// Reviewer 也要求严格输出 JSON，但模型不一定老实。
// 所以这里会尽量从文本中提取对象，并把字段修正成项目可接受的安全默认值。
export function safeParseReviewPayload(content: string): ReviewPayload {
  const trimmed = content.trim();
  const candidates = [trimmed];
  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Partial<ReviewPayload>;
      const decision =
        parsed.decision === "RETRY"
          ? "RETRY"
          : parsed.decision === "FAIL"
            ? "FAIL"
            : DEFAULT_REVIEW_PAYLOAD.decision;
      const feedback = typeof parsed.feedback === "string" ? parsed.feedback : "";
      const risks = Array.isArray(parsed.risks)
        ? parsed.risks.map(String)
        : DEFAULT_REVIEW_PAYLOAD.risks;
      const retryTasks = Array.isArray(parsed.retryTasks)
        ? parsed.retryTasks
            .map((value) => Number(value))
            .filter((value) => Number.isInteger(value))
            .filter((value) => value >= 0 && value < MAX_PARALLEL_MODIFIERS)
        : [];
      return { decision, feedback, risks, retryTasks };
    } catch {
      continue;
    }
  }

  return DEFAULT_REVIEW_PAYLOAD;
}
