/**
 * 模块职责：单工具、跟踪工具与批量工具执行。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { ToolMessage } from "@langchain/core/messages";
import { searchProjectIndex } from "@/app/lib/server/workspace-store";
import { startAgentTraceSpan } from "@/app/lib/agent-runtime/trace-store";
import { callMcpTool, findMcpTool, isMcpToolName, resolveMcpTools, validateMcpToolArguments } from "@/app/lib/mcp/client";
import { ToolCall, ToolExecutionResult, ToolRuntimeState, createEmptyTokenUsage, mergeTokenUsage, normalizeContent } from "./runtime-lifecycle";
import { applyFileChange, buildMcpApprovalRequest, createMcpApprovalToken, getDiff, getWorkerDiff, listDirectory, markWorkerFileReady, proposeFileChange, readFileFromLocalDisk, readToolStringArgument, runTerminalCommand, searchCodebase, stageWorkerFileChange } from "./workspace-file-tools";
import { truncateText } from "./terminal-and-memory";
/*
 * 单个工具调用执行器。
 *
 * Modify Agent 最终说的是“我要调用哪个工具、参数是什么”，
 * 真正落地执行是在这里完成的。
 * 这里还顺手收集 touchedFiles，方便后面 Reviewer 和校验节点知道哪些文件被影响了。
 */
export async function executeSingleTool(
  toolCall: ToolCall,
  state: ToolRuntimeState,
): Promise<ToolExecutionResult> {
  const args = toolCall.args || {};
  const currentWorkingDir = state.workingDir || process.cwd();
  const filePath = readToolStringArgument(args, "filePath");
  const touchedFiles = new Set<string>();
  const makeMessage = (
    content: string,
    name = toolCall.name,
    id = toolCall.id ?? "unknown_id",
  ) => new ToolMessage({ content, tool_call_id: id, name });

  if (toolCall.validationError) {
    return {
      messages: [
        makeMessage(
          [
            `工具参数校验失败: ${toolCall.validationError}`,
            toolCall.repairNotes?.length
              ? `已尝试自动修复: ${toolCall.repairNotes.join("；")}`
              : "未找到可安全自动修复的参数。",
            "请根据工具 Schema 重新生成一次调用。",
          ].join("\n"),
        ),
      ],
      touchedFiles: [],
      interactiveRequest: null,
      tokenUsage: createEmptyTokenUsage(),
    };
  }

  if (isMcpToolName(toolCall.name)) {
    const catalog = await resolveMcpTools(currentWorkingDir);
    const mcpTool = findMcpTool(catalog, toolCall.name);
    if (!mcpTool) {
      return {
        messages: [makeMessage(`MCP 工具不存在或服务当前不可用: ${toolCall.name}`)],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    }

    const validationErrors = validateMcpToolArguments(mcpTool, args);
    if (validationErrors.length > 0) {
      return {
        messages: [
          makeMessage(
            [
              "MCP 工具参数校验失败，尚未发送网络请求。",
              ...validationErrors.map((error) => `- ${error}`),
              "请根据 MCP 工具 Schema 修正参数后重试。",
            ].join("\n"),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    }

    const approvalToken = createMcpApprovalToken(state, toolCall.name, args);
    const approved = (state.approvedRiskActions || []).includes(approvalToken);
    if (mcpTool.requiresApproval && !approved) {
      return {
        messages: [makeMessage("MCP 工具等待用户批准，尚未执行。")],
        touchedFiles: [],
        interactiveRequest: buildMcpApprovalRequest(
          state,
          toolCall.name,
          args,
          approvalToken,
        ),
        tokenUsage: createEmptyTokenUsage(),
      };
    }

    try {
      const outcome = await callMcpTool(currentWorkingDir, mcpTool, args);
      return {
        messages: [
          makeMessage(
            `${outcome.isError ? "MCP 工具返回错误" : "MCP 工具执行成功"}:\n${truncateText(
              outcome.content,
              12_000,
            )}`,
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    } catch (error) {
      return {
        messages: [
          makeMessage(
            [
              "MCP 工具返回错误，当前调用未完成。",
              truncateText(
                error instanceof Error ? error.message : String(error),
                2_000,
              ),
              "请检查服务状态、改用其他工具或调整参数后重试。",
            ].join("\n"),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    }
  }

  switch (toolCall.name) {
    case "search_project_index":
      if (!state.projectId) {
        return {
          messages: [makeMessage("当前 Code 会话未绑定项目，无法查询项目索引。")],
          touchedFiles: [],
          interactiveRequest: null,
          tokenUsage: createEmptyTokenUsage(),
        };
      }
      return {
        messages: [
          makeMessage(
            JSON.stringify(
              searchProjectIndex(
                state.projectId,
                readToolStringArgument(args, "query"),
              ),
              null,
              2,
            ),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "list_directory":
      return {
        messages: [
          makeMessage(
            await listDirectory(
              readToolStringArgument(args, "dirPath") || ".",
              currentWorkingDir,
            ),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "search_codebase":
      return {
        messages: [
          makeMessage(
            await searchCodebase(
              readToolStringArgument(args, "keyword"),
              currentWorkingDir,
            ),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "read_file_from_disk":
      return {
        messages: [
          makeMessage(
            await readFileFromLocalDisk(
              filePath,
              currentWorkingDir,
              state.workerRuntime?.proposals,
            ),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "read_pdf_from_disk":
      return {
        messages: [
          makeMessage("当前版本未接入 PDF 解析器，请改用文件文本或后续补充实现。"),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "get_local_time":
      return {
        messages: [
          makeMessage(
            new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "propose_file_change": {
      touchedFiles.add(filePath);
      const proposalMessage = state.workerRuntime
        ? await stageWorkerFileChange(
            filePath,
            readToolStringArgument(args, "fileContent"),
            currentWorkingDir,
            state.workerRuntime,
          )
        : await proposeFileChange(
            filePath,
            readToolStringArgument(args, "fileContent"),
            currentWorkingDir,
          );
      const diffMessage = state.workerRuntime
        ? await getWorkerDiff(filePath, state.workerRuntime)
        : await getDiff(filePath, currentWorkingDir);

      return {
        messages: [
          makeMessage(proposalMessage),
          makeMessage(diffMessage, "get_diff", `${toolCall.id}-diff`),
        ],
        touchedFiles: [...touchedFiles],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    }
    case "get_diff":
      return {
        messages: [
          makeMessage(
            state.workerRuntime
              ? await getWorkerDiff(filePath, state.workerRuntime)
              : await getDiff(filePath, currentWorkingDir),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "apply_file_change":
      touchedFiles.add(filePath);
      return {
        messages: [
          makeMessage(
            state.workerRuntime
              ? markWorkerFileReady(filePath, state.workerRuntime)
              : await applyFileChange(filePath, currentWorkingDir),
          ),
        ],
        touchedFiles: [...touchedFiles],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
    case "run_terminal_command": {
      // 并发 Worker 阶段不允许直接在共享工作区执行终端修改或校验，
      // 否则 Merge 节点无法保证隔离性和冲突检测的准确性。
      if (state.workerRuntime) {
        return {
          messages: [
            makeMessage(
              "并发 Modify Worker 阶段禁止直接执行终端命令。请完成文件提案，Merge 落盘后系统会统一执行 Lint / Build / Test。",
            ),
          ],
          touchedFiles: [],
          interactiveRequest: null,
          tokenUsage: createEmptyTokenUsage(),
        };
      }

      const outcome = await runTerminalCommand(
        readToolStringArgument(args, "command"),
        currentWorkingDir,
        state,
      );
      return {
        messages: [
          makeMessage(
            [
              `命令模式: ${outcome.mode === "pty" ? "PTY 交互命令" : "普通命令"}`,
              outcome.output,
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
        ],
        touchedFiles: [],
        interactiveRequest: outcome.interactiveRequest,
        tokenUsage: outcome.tokenUsage,
      };
    }
    default:
      return {
        messages: [makeMessage(`Unknown tool: ${toolCall.name}`)],
        touchedFiles: [],
        interactiveRequest: null,
        tokenUsage: createEmptyTokenUsage(),
      };
  }
}

export async function executeTrackedTool(
  toolCall: ToolCall,
  state: ToolRuntimeState,
): Promise<ToolExecutionResult> {
  const endSpan = startAgentTraceSpan("tool", toolCall.name, {
    repaired: toolCall.repaired === true,
    repairNotes: toolCall.repairNotes || [],
    hasValidationError: Boolean(toolCall.validationError),
    workerId: state.workerRuntime?.workerId,
    slot: state.workerRuntime?.slot,
  });

  try {
    const result = await executeSingleTool(toolCall, state);
    const failed =
      Boolean(toolCall.validationError) ||
      result.messages.some((message) =>
        /(?:工具返回错误|参数校验失败)/u.test(
          normalizeContent(message.content),
        ),
      );
    endSpan(failed ? "failed" : "completed", {
      repaired: toolCall.repaired === true,
      interactive: Boolean(result.interactiveRequest),
      touchedFiles: result.touchedFiles,
    });
    return result;
  } catch (error) {
    endSpan("failed", {
      repaired: toolCall.repaired === true,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/*
 * 一批工具调用的执行调度器。
 *
 * 设计重点：
 * - 只读工具可以并行，提速；
 * - 写入工具必须串行，避免两个修改互相覆盖。
 *
 * 这其实就是整个 Modify 节点内部的“小型调度器”。
 */
export async function executeToolBatch(
  toolCalls: ToolCall[],
  state: ToolRuntimeState,
): Promise<ToolExecutionResult> {
  // 只读工具可以并行，写工具保持串行，避免多个改动互相覆盖。
  const readOnlyTools = new Set([
    "search_project_index",
    "list_directory",
    "search_codebase",
    "read_file_from_disk",
    "read_pdf_from_disk",
    "get_local_time",
  ]);

  const readOnlyCalls = toolCalls.filter((call) => readOnlyTools.has(call.name));
  const mutationCalls = toolCalls.filter((call) => !readOnlyTools.has(call.name));

  const results: ToolExecutionResult[] = [];
  results.push(
    ...(await Promise.all(
      readOnlyCalls.map((call) => executeTrackedTool(call, state)),
    )),
  );

  for (const call of mutationCalls) {
    results.push(await executeTrackedTool(call, state));
  }

  return {
    messages: results.flatMap((item) => item.messages),
    touchedFiles: Array.from(
      new Set(results.flatMap((item) => item.touchedFiles)),
    ),
    interactiveRequest:
      results.find((item) => item.interactiveRequest)?.interactiveRequest || null,
    tokenUsage: results.reduce(
      (accumulator, item) => mergeTokenUsage(accumulator, item.tokenUsage),
      createEmptyTokenUsage(),
    ),
  };
}
