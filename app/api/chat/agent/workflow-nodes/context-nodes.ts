/**
 * 模块职责：路由、检索、记忆、文件与上下文合并节点。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import fs from "fs";
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { DEFAULT_HIGH_LEVEL_PLAN, DEFAULT_MERGE_RESULT, DEFAULT_PLANNER_PAYLOAD, DEFAULT_REVIEW_PAYLOAD, DEFAULT_VERIFICATION_RESULT, PlannerValidationStatus } from "../types";
import { searchProjectIndex } from "@/app/lib/server/workspace-store";
import { readContextCache, writeContextCache } from "@/app/lib/agent-runtime/context-cache";
import { recordAgentTraceEvent } from "@/app/lib/agent-runtime/trace-store";
import { AgentRuntimeState, buildLifecycleStateUpdate, createLifecycleTracker, getLatestUserRequest } from "./runtime-lifecycle";
import { getSafePath, listDirectory, readFileFromLocalDisk, searchCodebase } from "./workspace-file-tools";
import { toConversationText, truncateText } from "./terminal-and-memory";
import { extractCandidatePaths } from "./planner-normalization";
/*
 * Router 是整个图的重置与分流起点。
 *
 * 它不负责理解代码细节，只负责把本轮流程相关的中间状态清空，
 * 然后根据用户请求粗略判断：这轮是否大概率需要进入“代码修改链路”。
 */
export async function routerNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const userRequest = getLatestUserRequest(state);
  return {
    currentUserRequest: userRequest,
    verificationResult: DEFAULT_VERIFICATION_RESULT,
    lintSummary: "",
    finalReportSummary: "",
    mergedContext: "",
    searchContext: "",
    memoryContext: "",
    fileContext: "",
    highLevelPlanRawOutput: "",
    highLevelPlan: DEFAULT_HIGH_LEVEL_PLAN,
    highLevelPlanSummary: "",
    plannerOutput: DEFAULT_PLANNER_PAYLOAD,
    plannerRawOutput: "",
    plannerValidationStatus: "pending" as PlannerValidationStatus,
    plannerValidationMessage: "",
    plannerRetryCount: 0,
    plannerRetryReason: "",
    modifyResults: [],
    mergeResult: DEFAULT_MERGE_RESULT,
    mergedPatchSummary: "",
    structuredTaskListSummary: "",
    reviewPayload: DEFAULT_REVIEW_PAYLOAD,
    reviewFeedback: "",
    reviewDecision: "PASS",
    retryTaskSlots: [],
    reviewIteration: 0,
    interactiveRequest: null,
    touchedFiles: [],
    agentLifecycles: {},
    agentLifecycleEvents: [],
    requiresChanges:
      /(改|修改|重构|优化|修复|实现|新增|持久化|planner|agent)/i.test(
        userRequest,
      ),
  };
}

// SearchAgent 的职责是“广度摸排”。
// 它会结合项目索引和代码库扫描，先告诉后面的 Planner：相关代码可能在哪些地方。
export async function searchAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "search_agent",
    "search_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("EXECUTING", "正在检索项目索引与代码库。");

  const userRequest = getLatestUserRequest(state);
  const lookup = {
    namespace: "search" as const,
    projectId: state.projectId || "",
    workingDir: state.workingDir || process.cwd(),
    userRequest,
    dependencyPaths: ["package.json", "pnpm-lock.yaml", "src", "app"],
  };
  const cached = readContextCache(lookup);
  if (cached.hit && cached.value) {
    tracker.transition(
      "COMPLETED",
      `命中 Search Context 缓存（${Math.round(cached.ageMs / 1000)} 秒前生成）。`,
    );
    recordAgentTraceEvent("cache", "search_context", "info", {
      hit: true,
      ageMs: cached.ageMs,
      key: cached.key,
    });
    return {
      searchContext: cached.value,
      ...buildLifecycleStateUpdate(tracker),
    };
  }

  recordAgentTraceEvent("cache", "search_context", "info", {
    hit: false,
    key: cached.key,
  });

  try {
    const searchResults = state.projectId
      ? JSON.stringify(
          searchProjectIndex(state.projectId, userRequest).slice(0, 8),
          null,
          2,
        )
      : "当前会话未绑定项目索引。";
    const codebaseResults = await searchCodebase(
      userRequest,
      state.workingDir || process.cwd(),
    );
    const searchContext = [
      `用户请求:\n${userRequest}`,
      `项目索引检索:\n${truncateText(searchResults, 3000)}`,
      `代码库扫描:\n${truncateText(codebaseResults, 3000)}`,
    ].join("\n\n");
    writeContextCache(lookup, searchContext);
    tracker.transition("COMPLETED", "项目索引与代码库检索完成并写入缓存。");

    return {
      searchContext,
      ...buildLifecycleStateUpdate(tracker),
    };
  } catch (error) {
    tracker.transition(
      "FAILED",
      `Search Agent 执行失败: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      searchContext: tracker.getSnapshot().detail,
      ...buildLifecycleStateUpdate(tracker),
    };
  }
}

// MemoryAgent 负责把“历史记忆”和“最近几轮上下文”整理出来。
// 这样 Planner 不会只看当前一句话，而是知道前面做过什么。
export async function memoryAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "memory_agent",
    "memory_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("EXECUTING", "正在整理长期摘要与近期对话上下文。");

  const memoryContext = [
    `长期对话记忆:\n${state.summary || "暂无长期记忆。"}`,
    `近期会话摘要:\n${
      toConversationText(state.messages, 8) || "暂无近期上下文。"
    }`,
  ].join("\n\n");
  tracker.transition("COMPLETED", "Memory Agent 已完成上下文整理。");

  return {
    memoryContext,
    ...buildLifecycleStateUpdate(tracker),
  };
}

// FileAgent 的目标是“把用户点名过的路径先预读出来”。
// 如果用户没有给路径，就退回到目录概览，至少让后续节点对项目结构有个感知。
export async function fileAgentNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "file_agent",
    "file_agent",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("EXECUTING", "正在读取用户点名路径或项目目录概览。");

  try {
    const userRequest = getLatestUserRequest(state);
    const workingDir = state.workingDir || process.cwd();
    const candidatePaths = extractCandidatePaths(userRequest).slice(0, 5);
    const lookup = {
      namespace: "file" as const,
      projectId: state.projectId || "",
      workingDir,
      userRequest,
      dependencyPaths: candidatePaths.length
        ? candidatePaths
        : ["package.json", "app", "src"],
    };
    const cached = readContextCache(lookup);
    if (cached.hit && cached.value) {
      tracker.transition(
        "COMPLETED",
        `命中 File Context 缓存（${Math.round(cached.ageMs / 1000)} 秒前生成）。`,
      );
      recordAgentTraceEvent("cache", "file_context", "info", {
        hit: true,
        ageMs: cached.ageMs,
        key: cached.key,
      });
      return {
        fileContext: cached.value,
        ...buildLifecycleStateUpdate(tracker),
      };
    }
    recordAgentTraceEvent("cache", "file_context", "info", {
      hit: false,
      key: cached.key,
    });

    if (candidatePaths.length === 0) {
      const fileContext = `未在用户请求中检测到明确文件路径。\n工作目录结构预览:\n${await listDirectory(
        ".",
        workingDir,
      )}`;
      writeContextCache(lookup, fileContext);
      tracker.transition("COMPLETED", "未检测到明确路径，已返回项目根目录概览。");
      return {
        fileContext,
        ...buildLifecycleStateUpdate(tracker),
      };
    }

    const sections: string[] = [];
    for (const candidatePath of candidatePaths) {
      const safePath = await getSafePath(candidatePath, workingDir);
      if (!fs.existsSync(safePath)) {
        sections.push(`路径不存在: ${candidatePath}`);
        continue;
      }

      const stat = fs.statSync(safePath);
      if (stat.isDirectory()) {
        sections.push(
          `目录 ${candidatePath}:\n${await listDirectory(candidatePath, workingDir)}`,
        );
        continue;
      }

      const content = await readFileFromLocalDisk(candidatePath, workingDir);
      const preview = content.split("\n").slice(0, 120).join("\n");
      sections.push(`文件 ${candidatePath} 预览:\n${preview}`);
    }

    const fileContext = sections.join("\n\n");
    writeContextCache(lookup, fileContext);
    tracker.transition(
      "COMPLETED",
      `File Agent 已处理 ${candidatePaths.length} 个候选路径并写入缓存。`,
    );
    return {
      fileContext,
      ...buildLifecycleStateUpdate(tracker),
    };
  } catch (error) {
    tracker.transition(
      "FAILED",
      `File Agent 执行失败: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      fileContext: tracker.getSnapshot().detail,
      ...buildLifecycleStateUpdate(tracker),
    };
  }
}

// 三个上下文 Agent 的结果会在这里汇总成一份 mergedContext。
// 后面的 Planner、Modify、Reviewer 基本都吃这份汇总文本。
export async function mergeContextNode(
  state: AgentRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const tracker = createLifecycleTracker(
    "context_merge",
    "context_merge",
    state.reviewIteration || 0,
    config,
  );
  tracker.transition("EXECUTING", "正在合并 Search、Memory 与 File 上下文。");

  const userRequest = getLatestUserRequest(state);
  const mergedContext = [
    `用户请求:\n${userRequest}`,
    `SearchAgent:\n${state.searchContext || "暂无搜索上下文。"}`,
    `MemoryAgent:\n${state.memoryContext || "暂无记忆上下文。"}`,
    `FileAgent:\n${state.fileContext || "暂无文件上下文。"}`,
  ].join("\n\n");
  tracker.transition("COMPLETED", "多路上下文合并完成。");

  return {
    mergedContext,
    ...buildLifecycleStateUpdate(tracker),
  };
}
