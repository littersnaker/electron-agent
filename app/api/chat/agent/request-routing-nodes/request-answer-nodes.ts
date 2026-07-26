/**
 * 模块职责：简单编辑规划、上下文补全与只读回答节点。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { completeWithLlm } from "@/app/lib/llm/gateway";
import { getRequestLlmCredentials } from "@/app/lib/llm/request-context";
import { ReadOnlyPromptText } from "../../prompt";
import type { PlannerValidationStatus } from "../types";
import { extractSimpleEditFiles } from "../request-classifier";
import { DEFAULT_PLANNER_PAYLOAD } from "../types";
import { buildWorkspaceRuntimeInfo, formatWorkspaceContext } from "../workspace-context";
import { AgentRuntimeState, getLatestUserImageParts } from "./request-routing-context";
/**
 * 为明确的单文档修改生成确定性单任务计划。
 *
 * simple_edit 不需要 High-Level Planner / Task Planner，也不需要 Search/Memory/File
 * 三路上下文收集；Worker 仍会在真正修改前读取磁盘文件，并按需查看 package.json
 * 或目录结构，因此安全边界不变，但能显著减少模型轮次。
 */
export function simpleEditPlanningNode(
  state: AgentRuntimeState,
): Record<string, unknown> {
  const files = extractSimpleEditFiles(state.currentUserRequest);
  const targetFile = files[0];

  if (!targetFile) {
    // 理论上 Router 已经保证 simple_edit 至少命中一个文件。
    // 这里保留兜底，避免分类规则未来调整后生成空文件任务。
    return {
      requestMode: "code_change",
      plannerOutput: DEFAULT_PLANNER_PAYLOAD,
      plannerValidationStatus: "pending" as PlannerValidationStatus,
      plannerValidationMessage:
        "simple_edit 未提取到明确目标文件，回退到完整 Planner 链路。",
    };
  }

  const approvedForCreation = (state.approvedMissingFiles || []).includes(
    targetFile,
  );
  const plan = [
    {
      id: "simple_edit_1",
      parentId: "simple_edit",
      task: state.currentUserRequest,
      files: [targetFile],
      reason: "用户明确指定单个文档文件，使用轻量修改链路。",
      acceptanceCriteria: [
        `只修改 ${targetFile}，除非用户需求明确要求其他文件。`,
        "内容必须完整覆盖用户需求，不得虚构项目技术栈或目录。",
        "需要描述技术栈或目录时，先读取 package.json 和相关目录确认事实。",
        approvedForCreation
          ? `用户已确认：如果 ${targetFile} 不存在，可以新建该文件。`
          : `如果 ${targetFile} 不存在，必须先经过缺失文件确认流程。`,
        "完成后必须生成可合并文件提案并由 Merge 统一落盘。",
      ],
      priority: "high" as const,
    },
  ];

  return {
    highLevelPlanRawOutput: "",
    highLevelPlan: [
      {
        id: "simple_edit",
        objective: state.currentUserRequest,
        scope: [targetFile],
        rationale: "单文件文档修改无需启动两层 Planner。",
        dependencies: [],
        priority: "high" as const,
      },
    ],
    highLevelPlanSummary: `轻量修改：${targetFile}`,
    plannerOutput: plan,
    plannerRawOutput: JSON.stringify(plan, null, 2),
    plannerValidationStatus: "files_unique" as PlannerValidationStatus,
    plannerValidationMessage: "simple_edit 已生成单文件确定性计划。",
    structuredTaskListSummary: [
      "执行模式: simple_edit",
      `目标文件: ${targetFile}`,
      approvedForCreation ? "缺失文件授权: 已允许新建" : "缺失文件授权: 不需要",
      `用户需求: ${state.currentUserRequest}`,
    ].join("\n"),
    requiresChanges: true,
  };
}

/** 将本地工作区信息附加到三路上下文之后，供只读回答和代码链路复用。 */
export function enrichContextNode(
  state: AgentRuntimeState,
): Record<string, unknown> {
  const workspaceInfo =
    state.workspaceInfo ??
    buildWorkspaceRuntimeInfo(state.workingDir, state.projectId);
  const workspaceContext = formatWorkspaceContext(workspaceInfo);

  return {
    workspaceInfo,
    mergedContext: [
      `Workspace:\n${workspaceContext}`,
      state.mergedContext || "暂无项目上下文。",
    ].join("\n\n"),
  };
}

/** 工作区元信息由本地代码直接回答，不调用模型，也不运行 Planner。 */
export function workspaceInfoAnswerNode(
  state: AgentRuntimeState,
): Record<string, unknown> {
  const workspaceInfo =
    state.workspaceInfo ??
    buildWorkspaceRuntimeInfo(state.workingDir, state.projectId);

  return {
    directAnswer: formatWorkspaceContext(workspaceInfo),
  };
}

/**
 * 只读请求只基于检索上下文回答，不允许声称执行了文件修改。
 * 该节点和完整 Code Agent 使用同一个模型配置，但不会挂载写入工具。
 */
export async function readOnlyAnswerNode(
  state: AgentRuntimeState,
): Promise<Record<string, unknown>> {
  const content = [
    `用户问题：\n${state.currentUserRequest}`,
    `项目上下文：\n${state.mergedContext}`,
  ].join("\n\n");
  const imageParts = getLatestUserImageParts(state);

  const payload = await completeWithLlm({
    task: "read_only",
    preferredModelId: state.model,
    credentials: getRequestLlmCredentials(),
    messages: [
      { role: "system", content: ReadOnlyPromptText },
      {
        role: "user",
        content,
        parts: imageParts.length
          ? [{ type: "text", text: content }, ...imageParts]
          : undefined,
      },
    ],
  });

  const directAnswer = payload.choices?.[0]?.message?.content?.trim();
  if (!directAnswer) {
    throw new Error("只读回答模型没有返回有效内容");
  }

  return {
    directAnswer,
    tokenUsage: {
      prompt: payload.usage?.prompt_tokens ?? 0,
      completion: payload.usage?.completion_tokens ?? 0,
      total: payload.usage?.total_tokens ?? 0,
    },
  };
}
