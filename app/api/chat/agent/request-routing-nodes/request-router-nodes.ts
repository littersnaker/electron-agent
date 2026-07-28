/**
 * 模块职责：请求路由、上下文扇出和缺失文件保护节点。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import fs from "fs";
import { extractExistingFileMutationTargets } from "../request-classifier";
import { type AgentRuntimeState, buildFileCreateConfirmation, buildFreshRunState, extractInteractiveReplyInstruction, getLatestUserRequest, isCreateApproval, isRiskApproval, resolveWorkspaceFilePath } from "./request-routing-context";
/**
 * V6 Router：重置本轮瞬态状态，并处理缺失文件确认卡片的恢复逻辑。
 *
 * 文件确认回复不会作为新的用户需求进入 Planner。点击“新建并继续”后会恢复
 * 原始请求，并把对应文件写入 approvedMissingFiles；点击“暂不新建”则直接结束本轮。
 */
export function requestRouterNode(
  state: AgentRuntimeState,
): Record<string, unknown> {
  const latestUserRequest = getLatestUserRequest(state);
  const replyInstruction = extractInteractiveReplyInstruction(latestUserRequest);
  const pendingRequest = state.interactiveRequest;

  if (
    replyInstruction &&
    (pendingRequest?.source === "risk_approval" ||
      pendingRequest?.source === "mcp_tool_approval") &&
    pendingRequest.id === replyInstruction.requestId
  ) {
    const originalUserRequest =
      pendingRequest.originalUserRequest?.trim() || state.currentUserRequest;
    const approvalToken = pendingRequest.approvalToken?.trim();
    const resumeTarget =
      pendingRequest.source === "mcp_tool_approval" ? "worker" : "merge";

    if (isRiskApproval(replyInstruction) && approvalToken) {
      return {
        currentUserRequest: originalUserRequest,
        requestMode: state.requestMode,
        directAnswer: "",
        interactiveRequest: null,
        approvedRiskActions: Array.from(
          new Set([...(state.approvedRiskActions || []), approvalToken]),
        ),
        resumeFromRiskApproval: true,
        approvalResumeTarget: resumeTarget,
        evaluationReportId: "",
        evaluationSummary: "",
        retryTaskSlots:
          resumeTarget === "worker" && typeof pendingRequest.slot === "number"
            ? [pendingRequest.slot]
            : state.retryTaskSlots || [],
      };
    }

    return {
      ...buildFreshRunState(state, originalUserRequest, []),
      requestMode: "read_only",
      requiresChanges: false,
      directAnswer:
        pendingRequest.source === "mcp_tool_approval"
          ? `已拒绝执行高风险 MCP 工具 \`${pendingRequest.toolName || "unknown"}\`，本轮任务已停止。`
          : "已拒绝高风险工作区写入，本轮生成的提案不会写入正式文件。",
    };
  }

  if (
    replyInstruction &&
    pendingRequest?.source === "file_create_confirmation" &&
    pendingRequest.id === replyInstruction.requestId
  ) {
    const originalUserRequest =
      pendingRequest.originalUserRequest?.trim() || state.currentUserRequest;
    const filePath = pendingRequest.filePath?.trim() || "目标文件";

    if (isCreateApproval(replyInstruction)) {
      const approvedMissingFiles = Array.from(
        new Set([...(state.approvedMissingFiles || []), filePath]),
      );
      return buildFreshRunState(
        state,
        originalUserRequest,
        approvedMissingFiles,
      );
    }

    return {
      ...buildFreshRunState(state, originalUserRequest, []),
      requestMode: "read_only",
      requiresChanges: false,
      directAnswer: `好的，暂不新建 \`${filePath}\`。这次修改已取消，项目中的现有文件不会被改动。`,
    };
  }

  // 普通新任务必须清空上一轮“允许创建”的授权，防止跨任务复用。
  return buildFreshRunState(state, latestUserRequest, []);
}

/** 只作为并行 Search / Memory / File 的稳定分发点。 */
export function contextFanoutNode(): Record<string, never> {
  return {};
}

/**
 * 在真正进入 Planner/Worker 之前检查用户明确指定的“既有文件修改目标”。
 *
 * 文件不存在时不会直接创建，而是向前端发一个确认请求；用户确认后本节点再次执行，
 * 看到 approvedMissingFiles 中已有授权才允许流程继续。
 */
export function missingFileGuardNode(
  state: AgentRuntimeState,
): Record<string, unknown> {
  if (
    state.requestMode !== "simple_edit" &&
    state.requestMode !== "code_change"
  ) {
    return { interactiveRequest: null };
  }

  const targets = extractExistingFileMutationTargets(state.currentUserRequest);
  if (!targets.length) return { interactiveRequest: null };

  const approved = new Set(
    (state.approvedMissingFiles || []).map((item) =>
      item.replace(/\\/gu, "/").replace(/^\.\//u, ""),
    ),
  );

  for (const filePath of targets) {
    const normalized = filePath.replace(/\\/gu, "/").replace(/^\.\//u, "");
    if (approved.has(normalized)) continue;

    const safePath = resolveWorkspaceFilePath(normalized, state.workingDir);
    if (!safePath || fs.existsSync(safePath)) continue;

    return {
      interactiveRequest: buildFileCreateConfirmation(state, normalized),
    };
  }

  return { interactiveRequest: null };
}
