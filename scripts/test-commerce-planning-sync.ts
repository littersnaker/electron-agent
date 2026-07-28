// 回归测试：Commerce 活动时间线与右侧任务规划必须使用同一阶段定义。
import assert from "node:assert/strict";
import {
  AMAZON_LISTING_STAGE_DEFINITIONS,
  COMMERCE_RESEARCH_STAGE_DEFINITIONS,
} from "../app/components/task-planning/config";
import { buildPlanningStages } from "../app/components/task-planning/derive";
import {
  AMAZON_LISTING_PROGRESS_STAGES,
  COMMERCE_RESEARCH_PROGRESS_STAGES,
  getCommerceActivityStageId,
} from "../app/lib/commerce/progress-stages";
import type { ToolActivity } from "../app/types/workspace";

function buildListingActivities(): ToolActivity[] {
  const now = Date.now();
  return AMAZON_LISTING_PROGRESS_STAGES.slice(0, 6).map((item, index) => ({
    id: `listing-${item.stage}`,
    label: item.title,
    stageId: getCommerceActivityStageId("listing", item.stage),
    detail: `执行 ${item.title}`,
    status: index === 5 ? "running" : "completed",
    startedAt: now + index,
    endedAt: index === 5 ? undefined : now + index + 1,
  }));
}

const listingStages = buildPlanningStages(
  AMAZON_LISTING_STAGE_DEFINITIONS,
  [],
  buildListingActivities(),
  true,
);

assert.deepEqual(
  listingStages.map((stage) => stage.title),
  AMAZON_LISTING_PROGRESS_STAGES.map((stage) => stage.title),
  "Listing 活动标题与任务规划标题必须完全一致",
);
assert.equal(
  listingStages[5]?.detail,
  "执行 生成 Amazon Listing",
  "活动实时说明必须同步到右侧当前阶段",
);
assert.deepEqual(
  listingStages.map((stage) => stage.status),
  ["completed", "completed", "completed", "completed", "completed", "active", "queued"],
  "前五步完成、第六步运行时，右侧规划必须显示相同进度",
);

const researchActivities: ToolActivity[] = COMMERCE_RESEARCH_PROGRESS_STAGES.map(
  (item, index) => ({
    id: `research-${item.stage}`,
    label: item.title,
    stageId: getCommerceActivityStageId("research", item.stage),
    status: "completed",
    startedAt: index,
    endedAt: index + 1,
  }),
);
const listingAfterModeSwitch = buildPlanningStages(
  AMAZON_LISTING_STAGE_DEFINITIONS,
  [],
  researchActivities,
  true,
);

assert.deepEqual(
  listingAfterModeSwitch.map((stage) => stage.status),
  ["active", "queued", "queued", "queued", "queued", "queued", "queued"],
  "切换到 Listing 模式后不得复用上一轮市场研究的完成状态",
);
assert.equal(COMMERCE_RESEARCH_STAGE_DEFINITIONS.length, 6);
assert.equal(AMAZON_LISTING_STAGE_DEFINITIONS.length, 7);

console.log("Commerce 任务规划同步测试通过");
