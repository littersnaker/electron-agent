import assert from "node:assert/strict";
import {
  buildPlanningStages,
  buildPlanningSummary,
  buildWorkListProgress,
} from "../app/components/task-planning/derive";
import type { AgentInstance } from "../app/components/AgentPanel";
import type { PlanningStageDefinition } from "../app/components/task-planning/types";

const definitions: PlanningStageDefinition[] = [
  {
    id: "understand",
    title: "理解需求",
    description: "识别问题",
    agentTypes: ["orchestrator"],
    activityKeys: ["理解"],
  },
  {
    id: "verify",
    title: "工程验证",
    description: "运行验证",
    agentTypes: ["terminal"],
    activityKeys: ["验证"],
  },
  {
    id: "deliver",
    title: "生成结果",
    description: "输出结果",
    agentTypes: ["orchestrator"],
    activityKeys: ["结果"],
  },
];

function makeAgent(
  type: AgentInstance["type"],
  status: AgentInstance["status"],
  progress: number,
): AgentInstance {
  return {
    id: type,
    name: type,
    type,
    status,
    progress,
    currentTask: "测试任务",
    updatedAt: Date.now(),
  };
}

const idleStages = buildPlanningStages(
  definitions,
  [makeAgent("orchestrator", "idle", 0)],
  [],
  false,
);
assert.equal(buildPlanningSummary(idleStages).overallProgress, 0);

const completedStages = buildPlanningStages(
  definitions,
  [
    makeAgent("orchestrator", "completed", 100),
    makeAgent("terminal", "queued", 0),
  ],
  [],
  false,
);
const completedSummary = buildPlanningSummary(completedStages);
assert.equal(completedSummary.overallProgress, 100);
assert.equal(completedSummary.completed, definitions.length);
assert.ok(completedSummary.skipped > 0);
assert.ok(
  completedStages.every((stage) =>
    ["completed", "skipped"].includes(stage.status),
  ),
);

const waitingStages = buildPlanningStages(
  definitions,
  [makeAgent("orchestrator", "running", 38)],
  [],
  false,
);
assert.ok(buildPlanningSummary(waitingStages).overallProgress < 100);
assert.ok(waitingStages.some((stage) => stage.status === "active"));

const failedStages = buildPlanningStages(
  definitions,
  [makeAgent("orchestrator", "error", 100)],
  [],
  false,
);
const failedSummary = buildPlanningSummary(failedStages);
assert.equal(failedSummary.failed, true);
assert.ok(failedStages.some((stage) => stage.status === "error"));
assert.ok(failedStages.some((stage) => stage.status !== "skipped"));

const workProgress = buildWorkListProgress({
  revision: 3,
  reason: "W002 失败，正在重规划",
  total: 3,
  pending: 1,
  running: 0,
  succeeded: 1,
  failed: 1,
  skipped: 0,
  overallProgress: 99,
  items: [
    {
      id: "W001",
      title: "已成功工作",
      objective: "完成 A",
      acceptanceCriteria: [],
      dependencies: [],
      status: "succeeded",
      attempts: 1,
      summary: "完成",
      error: "",
      changedFiles: ["a.ts"],
      commands: [],
    },
    {
      id: "W002",
      title: "失败工作",
      objective: "完成 B",
      acceptanceCriteria: [],
      dependencies: ["W001"],
      status: "failed",
      attempts: 1,
      summary: "",
      error: "测试失败",
      changedFiles: [],
      commands: ["pnpm test"],
    },
    {
      id: "W003",
      title: "待办工作",
      objective: "完成 C",
      acceptanceCriteria: [],
      dependencies: ["W002"],
      status: "pending",
      attempts: 0,
      summary: "",
      error: "",
      changedFiles: [],
      commands: [],
    },
  ],
});
assert.equal(workProgress?.overallProgress, 33);
assert.equal(workProgress?.failed, 1);

console.log("[任务规划测试] 阶段、WorkList 和失败重规划进度均符合预期");

// 后端历史版本可能发送小写状态；前端必须统一归一化后再计算。
const lifecycleStages = buildPlanningStages(
  [
    {
      id: "plan",
      title: "制定计划",
      description: "生成 WorkList",
      agentTypes: ["planner"],
      activityKeys: ["计划"],
      lifecycleRoles: ["task_planner"],
    },
    {
      id: "deliver",
      title: "生成结果",
      description: "输出结果",
      agentTypes: ["orchestrator"],
      activityKeys: ["结果"],
      lifecycleRoles: ["final_report_agent"],
    },
  ],
  [],
  [],
  false,
  "",
  [
    {
      id: "life_1",
      agentId: "task_planner",
      role: "task_planner",
      status: "completed",
      iteration: 1,
      detail: "已完成失败重规划",
      createdAt: "2026-08-01T00:00:00Z",
    },
    {
      id: "life_2",
      agentId: "final_report_agent",
      role: "final_report_agent",
      status: "completed",
      iteration: 1,
      detail: "交付完成",
      createdAt: "2026-08-01T00:00:01Z",
    },
  ],
);
assert.equal(buildPlanningSummary(lifecycleStages).overallProgress, 100);
