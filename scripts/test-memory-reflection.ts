import assert from "node:assert/strict";
import {
  rankMemories,
  resetMemoryRankingStats,
} from "../app/lib/agent-runtime/memory-ranking";
import { parseReflectionPayload } from "../app/lib/agent-runtime/reflection-parser";
import {
  advanceWorkingMemory,
  buildShortTermMemory,
} from "../app/lib/agent-runtime/three-layer-memory";


/** 验证 STM 排除当前用户请求，并清除模型内部思考标记。 */
function testShortTermMemory(): void {
  const messages = [
    {
      id: "history-user",
      content:
        "历史需求<INTERNAL_THINK_START>不可进入记忆<INTERNAL_THINK_END>",
      _getType: () => "human",
    },
    {
      id: "history-assistant",
      content: "历史回答",
      _getType: () => "ai",
    },
    {
      id: "latest-user",
      content: "当前请求",
      _getType: () => "human",
    },
  ] as unknown as Parameters<typeof buildShortTermMemory>[0];

  const memory = buildShortTermMemory(messages, 12);
  assert.equal(memory.items.length, 2);
  assert.ok(memory.items.every((item) => !item.content.includes("当前请求")));
  assert.ok(
    memory.items.every((item) => !item.content.includes("不可进入记忆")),
  );
}

/** 验证工作记忆会去重，并正确保留当前任务状态。 */
function testWorkingMemory(): void {
  const memory = advanceWorkingMemory(undefined, {
    goal: "加入三层记忆与 Reflection",
    phase: "executing",
    activeTaskIds: ["memory", "reflection", "memory"],
    pendingTaskIds: ["reflection"],
    keyFacts: ["项目已有 Router", "项目已有 Router"],
    risks: ["不得重复实现 Reviewer"],
    iteration: 1,
  });

  assert.deepEqual(memory.activeTaskIds, ["memory", "reflection"]);
  assert.deepEqual(memory.keyFacts, ["项目已有 Router"]);
  assert.equal(memory.phase, "executing");
}

/** 验证 STM、WM、LTM 能进入统一排序，且持久化访问次数会提高频率分。 */
function testThreeLayerRanking(): void {
  resetMemoryRankingStats();
  const ranked = rankMemories({
    query: "三层记忆架构和反思循环",
    maxTokens: 800,
    candidates: [
      {
        id: "stm",
        source: "short_term",
        content: "刚才讨论页面颜色",
        importance: 0.3,
      },
      {
        id: "wm",
        source: "working",
        content: "当前任务是实现三层记忆架构和 Reflection 循环",
        importance: 0.9,
      },
      {
        id: "ltm",
        source: "long_term",
        content: "项目已有 Agent Router 和 Reviewer，升级时不能重复实现",
        importance: 0.95,
        accessCount: 8,
      },
    ],
  });

  assert.equal(ranked.length, 3);
  assert.ok(["wm", "ltm"].includes(ranked[0].id));
  const longTerm = ranked.find((memory) => memory.id === "ltm");
  assert.ok(longTerm && longTerm.frequencyScore > 0);
}

/** 验证 Reflection JSON 的分值、槽位和重复经验会被安全归一化。 */
function testReflectionParser(): void {
  const payload = parseReflectionPayload(
    `前置说明
{
  "decision": "REVISE",
  "qualityScore": 1.4,
  "scores": {
    "requirementCoverage": 0.8,
    "correctness": 0.7,
    "verification": 0.2,
    "safety": 0.9,
    "maintainability": 0.8
  },
  "diagnosis": "测试失败，需要定向修复",
  "lessons": ["先执行目标测试", "先执行目标测试"],
  "retryTasks": [1, 1, 8],
  "memoryCandidates": [
    {
      "category": "lesson",
      "content": "项目修改后必须先执行目标测试",
      "importance": 0.82
    }
  ]
}
后置说明`,
    3,
  );

  assert.ok(payload);
  assert.equal(payload.decision, "REVISE");
  assert.equal(payload.qualityScore, 1);
  assert.deepEqual(payload.retryTasks, [1]);
  assert.deepEqual(payload.lessons, ["先执行目标测试"]);
  assert.equal(payload.memoryCandidates.length, 1);
  assert.equal(
    parseReflectionPayload('{"decision":"UNKNOWN"}', 2),
    null,
  );
}

function main(): void {
  testShortTermMemory();
  testWorkingMemory();
  testThreeLayerRanking();
  testReflectionParser();
  console.log("V12/V13 memory and reflection tests passed.");
}

main();
