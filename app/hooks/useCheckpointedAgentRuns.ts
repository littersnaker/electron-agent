"use client";

import { useCallback } from "react";
import type {
  AttachedFile,
  CodeAgentExecutionMode,
  ComposerMode,
  ImageEditFidelity,
  MediaMode,
  SessionMode,
  TypographyPolicy,
} from "../constants/page-constants";
import type { CommerceWorkflowMode } from "../lib/commerce/listing/types";
import type { CommerceMarketplaceCode } from "../lib/commerce/types";
import { buildCheckpointResumeRequest } from "../lib/checkpoint-resume";
import type {
  AgentCheckpoint,
  AgentCheckpointKind,
  AgentCheckpointRequest,
  CheckpointFinishResult,
} from "../types/checkpoints";
import type { ChatStreamController } from "./useChatStream";
import type { CommerceResearchController } from "./useCommerceResearch";
import type { MediaGenerationController } from "./useMediaGeneration";
import { useAgentCheckpoints } from "./useAgentCheckpoints";

interface UseCheckpointedAgentRunsOptions {
  sessionId?: string;
  sessionMode?: SessionMode;
  input: string;
  attachments: readonly AttachedFile[];
  selectedModel: string;
  composerMode: ComposerMode;
  codeAgentMode: CodeAgentExecutionMode;
  commerceWorkflowMode: CommerceWorkflowMode;
  commerceMarketplace: CommerceMarketplaceCode;
  typographyPolicy: TypographyPolicy;
  imageEditFidelity: ImageEditFidelity;
  enableQualityGuard: boolean;
  chat: ChatStreamController;
  media: MediaGenerationController;
  commerce: CommerceResearchController;
}

function routeFor(kind: AgentCheckpointKind, request: AgentCheckpointRequest): string {
  if (kind === "code") return "/api/chat";
  if (kind === "qa") return "/api/qa";
  if (kind === "media") return "/api/media/generate";
  return request.commerceWorkflowMode === "listing"
    ? "/api/commerce/listing"
    : "/api/commerce/research";
}

function labelFor(kind: AgentCheckpointKind, request: AgentCheckpointRequest): string {
  const text = request.input.trim().slice(0, 42);
  const prefix =
    kind === "code"
      ? "Code Agent"
      : kind === "media"
        ? "Media Agent"
        : kind === "commerce"
          ? "Commerce Agent"
          : "QA Agent";
  return text ? `${prefix} · ${text}` : prefix;
}

/**
 * 为所有 Agent 统一创建、完成和恢复 SQLite Checkpoint。
 *
 * Code Agent 会把 checkpointId 交给后端恢复精确 WorkList/工具循环；其他 Agent
 * 会复用保存的请求参数，从最后一条用户消息重新执行，避免重启后任务完全丢失。
 */
export function useCheckpointedAgentRuns(options: UseCheckpointedAgentRunsOptions) {
  const checkpoints = useAgentCheckpoints(options.sessionId);

  const finish = useCallback(
    async (checkpointId: string, result: CheckpointFinishResult) => {
      await checkpoints.update(checkpointId, result.status, result.error || "");
    },
    [checkpoints],
  );

  const run = useCallback(
    async (
      checkpointId: string,
      kind: AgentCheckpointKind,
      request: AgentCheckpointRequest,
      resume: boolean,
    ) => {
      const onCheckpointFinish = checkpointId
        ? (result: CheckpointFinishResult) => finish(checkpointId, result)
        : undefined;
      if (kind === "code" || kind === "qa") {
        await options.chat.submitPrompt(request.input, request.attachments, {
          checkpointId,
          resumeCheckpointId: kind === "code" && resume ? checkpointId : "",
          resumeExistingRun: resume,
          modelOverride: request.selectedModel,
          codeAgentModeOverride: request.codeAgentMode,
          onCheckpointFinish,
        });
        return;
      }
      if (kind === "media") {
        await options.media.submit(
          request.input,
          request.composerMode as MediaMode,
          {
            checkpointId,
            resumeExistingRun: resume,
            attachmentOverride: request.attachments[0] || null,
            modelOverride: request.selectedModel,
            typographyPolicyOverride: request.typographyPolicy,
            imageEditFidelityOverride: request.imageEditFidelity,
            enableQualityGuardOverride: request.enableQualityGuard,
            onCheckpointFinish,
          },
        );
        return;
      }
      await options.commerce.submitPrompt(request.input, {
        checkpointId,
        resumeExistingRun: resume,
        workflowModeOverride: request.commerceWorkflowMode,
        marketplaceOverride: request.commerceMarketplace,
        modelOverride: request.selectedModel,
        onCheckpointFinish,
      });
    },
    [finish, options.chat, options.commerce, options.media],
  );

  const buildRequest = useCallback(
    (): AgentCheckpointRequest => ({
      input: options.input,
      selectedModel: options.selectedModel,
      composerMode: options.composerMode,
      codeAgentMode: options.codeAgentMode,
      attachments: [...options.attachments],
      commerceWorkflowMode: options.commerceWorkflowMode,
      commerceMarketplace: options.commerceMarketplace,
      typographyPolicy: options.typographyPolicy,
      imageEditFidelity: options.imageEditFidelity,
      enableQualityGuard: options.enableQualityGuard,
    }),
    [options],
  );

  const submit = useCallback(async () => {
    if (!options.sessionId || !options.sessionMode) return;
    const request = buildRequest();
    const hasInput = Boolean(request.input.trim() || request.attachments.length);
    if (!hasInput) return;
    const kind: AgentCheckpointKind =
      options.sessionMode === "commerce"
        ? "commerce"
        : options.sessionMode === "code"
          ? "code"
          : options.composerMode === "chat"
            ? "qa"
            : "media";
    let checkpoint: AgentCheckpoint;
    try {
      checkpoint = await checkpoints.begin({
        agentKind: kind,
        route: routeFor(kind, request),
        request,
        label: labelFor(kind, request),
      });
    } catch (error) {
      console.error("[Checkpoint] 创建失败，将继续执行但本轮不可恢复", error);
      await run("", kind, request, false);
      return;
    }
    await run(checkpoint.id, kind, request, false);
  }, [buildRequest, checkpoints, options, run]);

  const resume = useCallback(
    async (checkpoint: AgentCheckpoint) => {
      const request = buildCheckpointResumeRequest(
        checkpoint.request,
        options.selectedModel,
      );
      // 同时更新 SQLite 中的请求快照。若本次又中断，下次恢复仍会沿用
      // 用户刚刚切换的新模型，而不会退回已经没额度的旧模型。
      await checkpoints.update(checkpoint.id, "running", "", request);
      await run(checkpoint.id, checkpoint.agentKind, request, true);
    },
    [checkpoints, options.selectedModel, run],
  );

  const discard = useCallback(async () => {
    if (checkpoints.checkpoint) {
      await checkpoints.discard(checkpoints.checkpoint.id);
    }
  }, [checkpoints]);

  return {
    checkpoint: checkpoints.checkpoint,
    loading: checkpoints.loading,
    submit,
    resume,
    discard,
  };
}
