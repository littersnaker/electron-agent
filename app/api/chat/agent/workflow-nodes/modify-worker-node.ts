/**
 * 模块职责：修改工作节点的完整执行逻辑。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { LangGraphRunnableConfig } from "@langchain/langgraph";
import { tools } from "../../tools";
import { InteractiveRequest, ModifyTaskResult, ModifyWorkerInput, WorkerFileChange, WorkerMemory, createDefaultWorkerMemory } from "../types";
import { repairToolCall } from "@/app/lib/agent-runtime/tool-repair";
import { resolveMcpTools } from "@/app/lib/mcp/client";
import { ModifyWorkerPromptText } from "../../prompt";
import { MAX_SIMPLE_WORKER_TOOL_ROUNDS, MAX_WORKER_TOOL_ROUNDS, ModifyWorkerRuntimeState, ToolRuntimeState, WorkerToolRuntime, buildLifecycleStateUpdate, buildTokenUsage, createEmptyTokenUsage, createLifecycleTracker, mergeTokenUsage, normalizeContent } from "./runtime-lifecycle";
import { buildWorkerContinuationMessage, compressWorkerMemory, invokeLlm, shouldCompressWorkerMemory, truncateText } from "./terminal-and-memory";
import { buildModifyResult } from "./planner-normalization";
import { executeToolBatch } from "./tool-execution";
import { arePreviousChangesAlreadyApplied } from "./workspace-file-tools";
/*
 * 动态 Modify Worker。
 *
 * 每次调用都来自一个独立 Send：
 * - 只接收自己的 task 和只读 SharedWorkerMemory；
 * - AI/Tool 消息仅保存在本函数的 runtimeMessages 中；
 * - 不向主图 messages 写入任何 Worker 消息；
 * - 文件修改只暂存在 proposals Map，最终由 Merge 节点统一落盘。
 */
export async function modifyWorkerNode(
  state: ModifyWorkerRuntimeState,
  config?: LangGraphRunnableConfig,
): Promise<Record<string, unknown>> {
  const input = state as unknown as ModifyWorkerInput;
  const { workerId, slot, task, sharedMemory } = input;
  const tracker = createLifecycleTracker(
    workerId,
    "modify_worker",
    input.reviewIteration || 0,
    config,
    slot,
  );
  tracker.transition("PLANNING", `正在准备任务 ${task.id} 的独立执行上下文。`);

  const proposals = new Map<string, WorkerFileChange>();
  const workerRuntime: WorkerToolRuntime = { workerId, slot, proposals };
  let workerMemory: WorkerMemory = {
    ...(input.previousMemory || createDefaultWorkerMemory()),
    completedActions: [...(input.previousMemory?.completedActions || [])],
    pendingActions: [...(input.previousMemory?.pendingActions || [])],
    keyFiles: [...(input.previousMemory?.keyFiles || [])],
    recentObservations: [...(input.previousMemory?.recentObservations || [])],
  };

  const runtimeState = {
    model: input.model,
    workingDir: input.workingDir,
    projectId: input.projectId,
    interactiveRequest: input.interactiveRequest,
    approvedRiskActions: input.approvedRiskActions || [],
    currentUserRequest: sharedMemory.latestUserRequest,
    messages: [],
    summary: sharedMemory.summary,
    mergedContext: sharedMemory.mergedContext,
    workerRuntime,
  } as unknown as ToolRuntimeState;

  let runtimeMessages: Array<Record<string, unknown>> = [
    {
      role: "user",
      content: [
        `用户原始需求:\n${sharedMemory.latestUserRequest}`,
        `当前 Worker: ${workerId}`,
        `当前槽位: ${slot + 1}`,
        `当前独立任务:\n${JSON.stringify(task, null, 2)}`,
        `High-Level Plan 摘要:\n${
          sharedMemory.highLevelPlanSummary || "暂无"
        }`,
        `共享只读 Memory:\n${sharedMemory.summary || "暂无长期记忆"}`,
        `合并上下文:\n${truncateText(
          sharedMemory.mergedContext || "暂无",
          5000,
        )}`,
        `前序 Worker 压缩记忆:\n${JSON.stringify(workerMemory, null, 2)}`,
        `前序同槽位结果:\n${
          input.previousResult
            ? JSON.stringify(
                {
                  workerId: input.previousResult.workerId,
                  status: input.previousResult.status,
                  summary: input.previousResult.summary,
                  touchedFiles: input.previousResult.touchedFiles,
                  fileChanges: input.previousResult.fileChanges.map((change) => ({
                    filePath: change.filePath,
                    proposedContentHash: change.proposedContentHash,
                    ready: change.ready,
                  })),
                },
                null,
                2,
              )
            : "无"
        }`,
        `Review 轮次: ${input.reviewIteration || 0}`,
        `Reviewer 反馈:\n${input.reviewFeedback || "暂无反馈"}`,
        `用户已确认可新建的缺失文件:\n${
          input.approvedMissingFiles.length
            ? input.approvedMissingFiles.join(", ")
            : "无"
        }`,
        "执行要求:",
        "1. 只处理当前任务，不读取或推测其他 Worker 的消息和执行过程。",
        "2. 必须先定位并读取真实文件。若读取结果为文件不存在，只有该路径出现在“用户已确认可新建的缺失文件”列表中，才可以按新文件生成完整内容；否则不得擅自创建。",
        "3. 文件闭环使用 read -> propose_file_change -> 检查返回 diff -> apply_file_change；propose_file_change 已自动返回 diff，无需重复调用 get_diff。",
        "4. apply_file_change 只表示加入 Merge 队列，不会立即覆盖正式文件。",
        "5. 并发 Worker 阶段不要执行终端命令，验证会在 Merge 后统一运行。",
        "6. 尽量只修改 Planner 分配的文件；确需扩散时必须说明原因。",
        "7. 达到上下文阈值后系统会压缩本 Worker 历史，不影响其他 Worker。",
      ].join("\n\n"),
    },
  ];
  const totalUsage = createEmptyTokenUsage();
  let toolRound = workerMemory.lastCompressedRound || 0;
  tracker.transition("EXECUTING", `开始执行并发任务 ${task.id}。`);

  const buildResultUpdate = (
    summary: string,
    status: ModifyTaskResult["status"],
    interactiveRequest: InteractiveRequest | null = null,
    fileChangesOverride?: WorkerFileChange[],
  ): Record<string, unknown> => {
    const changes = (
      fileChangesOverride || Array.from(proposals.values())
    ).sort((left, right) => left.filePath.localeCompare(right.filePath));
    const lifecycleUpdate = buildLifecycleStateUpdate(tracker);
    return {
      modifyResults: [
        buildModifyResult(
          workerId,
          slot,
          task,
          summary,
          status,
          changes,
          workerMemory,
          tracker.getSnapshot(),
          [...tracker.events],
          interactiveRequest,
        ),
      ],
      tokenUsage: totalUsage,
      ...lifecycleUpdate,
    };
  };

  try {
    const maxToolRounds =
      input.requestMode === "simple_edit"
        ? MAX_SIMPLE_WORKER_TOOL_ROUNDS
        : MAX_WORKER_TOOL_ROUNDS;

    for (let attempt = 0; attempt < maxToolRounds; attempt += 1) {
      const response = await invokeLlm(
        runtimeState,
        [
          {
            role: "system",
            content: ModifyWorkerPromptText,
          },
          ...runtimeMessages,
        ],
        "worker",
        true,
      );

      const usage = buildTokenUsage(response.usage);
      totalUsage.prompt += usage.prompt;
      totalUsage.completion += usage.completion;
      totalUsage.total += usage.total;

      const assistantMessage = response.choices?.[0]?.message;
      const toolCalls = assistantMessage?.tool_calls || [];

      if (toolCalls.length > 0) {
        const toolNames = toolCalls.map((item) => item.function.name);
        tracker.transition(
          "WAITING_TOOL",
          `正在执行工具: ${toolNames.join(", ")}`,
          toolNames.join(","),
        );
        runtimeMessages.push({
          role: "assistant",
          content: assistantMessage?.content || "",
          tool_calls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
          })),
        });

        const mcpCatalog = await resolveMcpTools(input.workingDir);
        const availableToolNames = [
          ...tools.map((tool) => tool.function.name),
          ...mcpCatalog.map((tool) => tool.llmName),
        ];
        const repairedToolCalls = toolCalls.map((toolCall) =>
          repairToolCall(
            {
              id: toolCall.id,
              name: toolCall.function.name,
              arguments: toolCall.function.arguments,
            },
            availableToolNames,
          ),
        );
        const executed = await executeToolBatch(repairedToolCalls, runtimeState);

        const mergedToolUsage = mergeTokenUsage(totalUsage, executed.tokenUsage);
        totalUsage.prompt = mergedToolUsage.prompt;
        totalUsage.completion = mergedToolUsage.completion;
        totalUsage.total = mergedToolUsage.total;

        executed.messages.forEach((message) => {
          runtimeMessages.push({
            role: "tool",
            content: normalizeContent(message.content),
            tool_call_id: message.tool_call_id,
          });
        });
        toolRound += 1;
        tracker.transition(
          "EXECUTING",
          `第 ${toolRound} 轮工具执行完成，继续判断下一步。`,
        );

        if (executed.interactiveRequest) {
          const decoratedRequest: InteractiveRequest = {
            ...executed.interactiveRequest,
            workerId,
            slot,
          };
          tracker.transition("BLOCKED", "Worker 正在等待交互式终端输入。");
          return buildResultUpdate(
            [
              `${workerId} 被交互式命令暂停。`,
              `命令: ${decoratedRequest.command}`,
              `提示: ${decoratedRequest.prompt}`,
            ].join("\n"),
            "blocked",
            decoratedRequest,
          );
        }

        /**
         * simple_edit 只处理单文档任务。apply_file_change 已把全部提案标记 ready 后，
         * 可以直接交给 Merge，不需要再消耗一次模型调用来重复说“完成”。
         */
        if (
          input.requestMode === "simple_edit" &&
          proposals.size > 0 &&
          Array.from(proposals.values()).every((change) => change.ready)
        ) {
          tracker.transition(
            "READY_TO_MERGE",
            `轻量修改已生成 ${proposals.size} 个可合并文件提案。`,
          );
          tracker.transition(
            "COMPLETED",
            `Worker ${workerId} 已完成轻量修改，等待 Merge。`,
          );
          return buildResultUpdate(
            `${workerId} 已完成轻量单文件修改并准备交给 Merge。`,
            "done",
          );
        }

        if (
          input.requestMode !== "simple_edit" &&
          shouldCompressWorkerMemory(runtimeMessages, toolRound, workerMemory)
        ) {
          tracker.transition(
            "COMPRESSING",
            `正在压缩 ${workerId} 的独立工具上下文。`,
          );
          try {
            const compressed = await compressWorkerMemory(
              runtimeState,
              task,
              workerMemory,
              runtimeMessages,
              toolRound,
            );
            workerMemory = compressed.memory;
            const mergedCompressionUsage = mergeTokenUsage(
              totalUsage,
              compressed.tokenUsage,
            );
            totalUsage.prompt = mergedCompressionUsage.prompt;
            totalUsage.completion = mergedCompressionUsage.completion;
            totalUsage.total = mergedCompressionUsage.total;
            runtimeMessages = [
              buildWorkerContinuationMessage(
                task,
                sharedMemory,
                workerMemory,
                input.reviewFeedback,
              ),
            ];
            tracker.transition(
              "EXECUTING",
              `Worker Memory 第 ${workerMemory.compressionCount} 次压缩完成。`,
            );
          } catch (compressionError) {
            workerMemory = {
              ...workerMemory,
              recentObservations: [
                ...workerMemory.recentObservations,
                `上下文压缩失败: ${
                  compressionError instanceof Error
                    ? compressionError.message
                    : String(compressionError)
                }`,
              ].slice(-8),
            };
            tracker.transition(
              "EXECUTING",
              "Worker Memory 压缩失败，保留当前上下文继续执行。",
            );
          }
        }
        continue;
      }

      const changes = Array.from(proposals.values()).sort((left, right) =>
        left.filePath.localeCompare(right.filePath),
      );
      const unreadyChanges = changes.filter((change) => !change.ready);
      const baseSummary =
        assistantMessage?.content?.trim() || `${workerId} 已完成当前任务。`;

      if (changes.length === 0) {
        if (
          input.reviewIteration > 0 &&
          input.previousResult &&
          (await arePreviousChangesAlreadyApplied(
            input.previousResult,
            input.workingDir,
          ))
        ) {
          tracker.transition(
            "COMPLETED",
            "Worker 未生成新提案，但上一轮目标内容仍已落盘。",
          );
          return buildResultUpdate(
            `${baseSummary}\n已确认上一轮目标内容仍在工作区中，本轮无需重复修改。`,
            "satisfied",
            null,
            input.previousResult.fileChanges,
          );
        }

        tracker.transition(
          "FAILED",
          "Worker 未生成任何文件提案，且无法确认已有目标内容已落盘。",
        );
        return buildResultUpdate(
          `${baseSummary}\n当前任务未产生文件提案，也没有可复用的已落盘结果。`,
          "failed",
        );
      }

      if (unreadyChanges.length) {
        tracker.transition(
          "FAILED",
          `存在 ${unreadyChanges.length} 个提案未加入 Merge 队列。`,
        );
        return buildResultUpdate(
          `${baseSummary}\n存在 ${unreadyChanges.length} 个提案未调用 apply_file_change，暂不允许 Merge 落盘。`,
          "failed",
        );
      }

      tracker.transition(
        "READY_TO_MERGE",
        `已生成 ${changes.length} 个可合并文件提案。`,
      );
      tracker.transition(
        "COMPLETED",
        `Worker ${workerId} 执行完成，等待 Merge。`,
      );
      return buildResultUpdate(baseSummary, "done");
    }

    tracker.transition("FAILED", "达到最大工具轮次，Worker 未能稳定收尾。");
    return buildResultUpdate(
      "达到最大工具轮次，Worker 未能稳定收尾。",
      "failed",
    );
  } catch (error) {
    tracker.transition(
      "FAILED",
      `Worker 执行失败: ${error instanceof Error ? error.message : String(error)}`,
    );
    return buildResultUpdate(tracker.getSnapshot().detail, "failed");
  }
}
