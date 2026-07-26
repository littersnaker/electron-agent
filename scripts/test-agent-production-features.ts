import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getContextCacheStats,
  invalidateProjectContextCache,
  readContextCache,
  writeContextCache,
} from "../app/lib/agent-runtime/context-cache";
import { evaluateAgentRun } from "../app/lib/agent-runtime/evaluation";
import { repairToolCall } from "../app/lib/agent-runtime/tool-repair";
import {
  validateMcpToolArguments,
  type McpResolvedTool,
} from "../app/lib/mcp/client";
import {
  DEFAULT_MERGE_RESULT,
  DEFAULT_REVIEW_PAYLOAD,
  DEFAULT_VERIFICATION_RESULT,
} from "../app/api/chat/agent/types";

/** 验证模型常见的 Markdown JSON、参数别名和尾随逗号可以被安全修复。 */
function testToolRepair(): void {
  const repaired = repairToolCall(
    {
      id: "tool-1",
      name: "propose-file-change",
      arguments:
        '```json\n{“path”:“app/page.tsx”,“content”:“export default 1”,}\n```',
    },
    ["propose_file_change"],
  );

  assert.equal(repaired.name, "propose_file_change");
  assert.equal(repaired.validationError, null);
  assert.equal(repaired.args.filePath, "app/page.tsx");
  assert.equal(repaired.args.fileContent, "export default 1");
  assert.equal(repaired.repaired, true);
  assert.ok(repaired.repairNotes.length >= 2);

  const invalid = repairToolCall(
    {
      name: "read_file_from_disk",
      arguments: "{}",
    },
    ["read_file_from_disk"],
  );
  assert.match(invalid.validationError || "", /filePath/u);
}

/** 验证缓存命中、依赖文件指纹变化和项目级失效。 */
function testContextCache(): void {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-cache-"));
  const dependencyPath = path.join(workingDir, "package.json");
  fs.writeFileSync(dependencyPath, '{"name":"cache-test"}', "utf-8");

  const lookup = {
    namespace: "file" as const,
    projectId: "cache-test-project",
    workingDir,
    userRequest: "读取 package.json",
    dependencyPaths: ["package.json"],
  };

  assert.equal(readContextCache(lookup).hit, false);
  writeContextCache(lookup, "缓存正文");
  assert.equal(readContextCache(lookup).value, "缓存正文");

  fs.writeFileSync(dependencyPath, '{"name":"cache-test-v2"}', "utf-8");
  assert.equal(readContextCache(lookup).hit, false);

  writeContextCache(lookup, "第二份缓存");
  assert.equal(invalidateProjectContextCache("cache-test-project"), 2);
  assert.equal(readContextCache(lookup).hit, false);
  assert.ok(getContextCacheStats().writes >= 2);

  fs.rmSync(workingDir, { recursive: true, force: true });
}


/** 验证 MCP 工具参数在发送网络请求前会按服务器 Schema 做本地拦截。 */
function testMcpSchemaValidation(): void {
  const tool: McpResolvedTool = {
    serverId: "test-server",
    serverName: "测试 MCP",
    remoteName: "write_note",
    llmName: "mcp__test_server__write_note",
    description: "写入一条测试笔记。",
    inputSchema: {
      type: "object",
      required: ["title", "priority"],
      additionalProperties: false,
      properties: {
        title: { type: "string", minLength: 2 },
        priority: { type: "integer", minimum: 1, maximum: 5 },
      },
    },
    requiresApproval: true,
  };

  assert.deepEqual(
    validateMcpToolArguments(tool, { title: "缓存说明", priority: 3 }),
    [],
  );
  const errors = validateMcpToolArguments(tool, {
    title: "A",
    priority: 9,
    unknown: true,
  });
  assert.ok(errors.some((item) => item.includes("title")));
  assert.ok(errors.some((item) => item.includes("priority")));
  assert.ok(errors.some((item) => item.includes("unknown")));
}

/** 验证在线评估会生成 Ragas 兼容样本与完整 Agent 指标。 */
function testEvaluation(): void {
  const report = evaluateAgentRun({
    projectId: "evaluation-test",
    requiresChanges: false,
    userRequest: "请读取项目并说明状态缓存如何工作",
    response: "状态缓存使用 TTL，并在文件写入后失效。",
    retrievedContexts: ["Context Cache 使用 TTL；Merge 写入后按项目失效。"],
    modifyResults: [],
    mergeResult: DEFAULT_MERGE_RESULT,
    reviewPayload: DEFAULT_REVIEW_PAYLOAD,
    reviewDecision: "PASS",
    verificationResult: DEFAULT_VERIFICATION_RESULT,
  });

  assert.equal(report.engine, "ragas-compatible-heuristic-v1");
  assert.equal(report.ragasSample.user_input.includes("状态缓存"), true);
  assert.equal(report.ragasSample.retrieved_contexts.length, 1);
  assert.ok(report.overallScore >= 0 && report.overallScore <= 1);
}

function main(): void {
  testToolRepair();
  testContextCache();
  testMcpSchemaValidation();
  testEvaluation();
  console.log("Agent 六项生产能力回归测试通过。");
}

main();
