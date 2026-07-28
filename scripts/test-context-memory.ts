// 模块说明：验证上下文预算裁剪与记忆排序的关键边界行为。
import assert from "node:assert/strict";
import {
  estimateMessageTokens,
  manageContextBudget,
} from "../app/lib/agent-runtime/context-budget-manager";
import {
  rankMemories,
  resetMemoryRankingStats,
} from "../app/lib/agent-runtime/memory-ranking";

function testContextBudgetCompaction(): void {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: "必须保留的系统规则。" },
    { role: "user", content: `旧问题：${"旧上下文".repeat(600)}` },
    { role: "assistant", content: `旧回答：${"历史结果".repeat(600)}` },
    { role: "user", content: "最新问题：请修复登录接口。" },
  ];
  const result = manageContextBudget({
    task: "worker",
    messages,
    policy: {
      contextWindowTokens: 1_200,
      outputReserveTokens: 300,
      safetyMarginTokens: 100,
      minimumMessageTokens: 64,
    },
  });

  assert.equal(result.report.wasCompacted, true);
  assert.equal(result.report.budgetSatisfied, true);
  assert.ok(result.report.droppedMessageCount > 0);
  assert.equal(result.messages[0]?.role, "system");
  assert.equal(result.messages.at(-1)?.role, "user");
  assert.match(String(result.messages.at(-1)?.content), /修复登录接口/u);
  assert.ok(
    result.messages.reduce(
      (total, message) => total + estimateMessageTokens(message),
      0,
    ) <= result.report.inputBudgetTokens + 16,
  );
}

function testMemoryRanking(): void {
  resetMemoryRankingStats();
  const ranked = rankMemories({
    query: "修复登录接口的 token 过期错误",
    candidates: [
      {
        id: "login-token",
        source: "long_term",
        content: "登录接口曾出现 token 过期错误，必须刷新凭证后重试。",
        importance: 0.95,
      },
      {
        id: "theme",
        source: "recent_conversation",
        content: "用户喜欢深色主题。",
        importance: 0.4,
      },
      {
        id: "login-duplicate",
        source: "recent_conversation",
        content: "登录接口 token 过期时需要刷新凭证并重试。",
        importance: 0.8,
      },
    ],
    limit: 2,
    maxTokens: 200,
    nowMs: Date.parse("2026-07-28T00:00:00Z"),
  });

  assert.equal(ranked.length, 2);
  assert.match(ranked[0]?.id || "", /^login-/u);
  assert.ok(ranked.every((memory) => memory.id.startsWith("login-")));
  assert.ok(!ranked.some((memory) => memory.id === "theme"));
  assert.ok(
    ranked.reduce((total, memory) => total + memory.estimatedTokens, 0) <= 200,
  );
}

function main(): void {
  testContextBudgetCompaction();
  testMemoryRanking();
  console.log("Context Budget Manager 与 Memory Ranking 测试通过。");
}

main();
