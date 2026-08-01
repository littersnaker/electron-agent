import assert from "node:assert/strict";
import { buildPlanningStages, buildPlanningSummary } from "../app/components/task-planning/derive";
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

console.log("[任务规划测试] 完成态、等待态和失败态进度均符合预期");
