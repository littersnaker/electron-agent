// 模块说明：负责 page 页面或应用入口逻辑。
/* eslint-disable react-hooks/immutability */
"use client";
import { useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import AgentPanel from "./components/AgentPanel";
import InteractiveRequestPanel from "./components/InteractiveRequestPanel";
import TaskPlanningPanel from "./components/TaskPlanningPanel";
import PluginCenter from "./components/plugins/PluginCenter";
import ApiKeyModal from "./components/ApiKeyModal";
import { ChatComposer } from "./components/ChatComposer";
import CheckpointResumeBar from "./components/CheckpointResumeBar";
import ChatList from "./components/ChatList";
import ChatSidebar from "./components/ChatSidebar";
import CustomTitleBar from "./components/CustomTitleBar";
import WorkspaceHeader from "./components/WorkspaceHeader";
import {
  AVAILABLE_CHAT_MODELS,
  getAvailableMediaModelOptions,
  getCustomModelOptions,
} from "./constants/modelList";
import type {
  ComposerMode,
  ImageEditFidelity,
  SessionMode,
  TypographyPolicy,
} from "./constants/page-constants";
import { getThemeVariables } from "./constants/theme";
import { useAgentCoordinator } from "./hooks/useAgentCoordinator";
import { useApiKey } from "./hooks/useApiKey";
import { useChatStream } from "./hooks/useChatStream";
import { useCodeAgentMode } from "./hooks/useCodeAgentMode";
import { useCheckpointedAgentRuns } from "./hooks/useCheckpointedAgentRuns";
import { useComposer } from "./hooks/useComposer";
import { useCommerceResearch } from "./hooks/useCommerceResearch";
import { useCustomModels } from "./hooks/useCustomModels";
import { useMediaGeneration } from "./hooks/useMediaGeneration";
import { useModelSelection } from "./hooks/useModelSelection";
import { usePluginManager } from "./hooks/usePluginManager";
import { useThemeMode } from "./hooks/useThemeMode";
import { useWorkspaceController } from "./hooks/useWorkspaceController";
import type { CommerceMarketplaceCode } from "./lib/commerce/types";
import { AUTO_MODEL_ID } from "./lib/llm/registry/models";
import type { BuiltinPluginId } from "./lib/plugins/types";
/**
 * Multi-agent 工作台页面入口。
 *
 * 普通聊天仍走原有 LLM Gateway；图片/视频生成走独立 Media Route；
 * Cross-border Market Intelligence 走独立 Commerce Research Route。三类工作流彼此隔离，避免
 * 媒体协议、Code Agent 状态机与市场研究 SSE 互相污染。
 */
export default function Home() {
  const [composerMode, setComposerMode] = useState<ComposerMode>("chat");
  const {
    selectedChatModel,
    selectedMediaModel,
    setSelectedChatModel,
    setSelectedMediaModel,
  } = useModelSelection();
  const customModels = useCustomModels();
  const { codeAgentMode, setCodeAgentMode } = useCodeAgentMode();
  const [typographyPolicy, setTypographyPolicy] =
    useState<TypographyPolicy>("avoid-generated-text");
  const [imageEditFidelity, setImageEditFidelity] =
    useState<ImageEditFidelity>("precise");
  const [enableQualityGuard, setEnableQualityGuard] = useState(true);
  const [commerceMarketplace, setCommerceMarketplace] =
    useState<CommerceMarketplaceCode>("US");
  const [showPluginCenter, setShowPluginCenter] = useState(false);
  const { theme, toggleTheme } = useThemeMode();
  const apiKey = useApiKey();
  const composer = useComposer();
  const plugins = usePluginManager();
  const codePluginEnabled = plugins.isEnabled("code-agent");
  const commercePluginEnabled = plugins.isEnabled("commerce-research");
  const mediaPluginEnabled = plugins.isEnabled("media-agent");
  const workspace = useWorkspaceController({
    includeCode: codePluginEnabled,
    includeCommerce: commercePluginEnabled,
    includeMedia: mediaPluginEnabled,
  });
  const agentCoordinator = useAgentCoordinator();
  const effectiveComposerMode: ComposerMode =
    workspace.activeSession?.mode === "code" ||
    workspace.activeSession?.mode === "commerce" ||
    workspace.activeSession?.mode === "media"
      ? "chat"
      : composerMode;
  const availableModels = useMemo(() => {
    if (effectiveComposerMode === "chat") {
      return [
        ...AVAILABLE_CHAT_MODELS,
        ...getCustomModelOptions(customModels.models),
      ];
    }
    return getAvailableMediaModelOptions(effectiveComposerMode);
  }, [customModels.models, effectiveComposerMode]);
  useEffect(() => {
    if (!customModels.loaded || !selectedChatModel.startsWith("custom:")) return;
    const stillExists = customModels.models.some(
      (model) => model.id === selectedChatModel,
    );
    if (!stillExists) setSelectedChatModel(AUTO_MODEL_ID);
  }, [
    customModels.loaded,
    customModels.models,
    selectedChatModel,
    setSelectedChatModel,
  ]);
  const resolvedMediaModel =
    availableModels.find((model) => model.id === selectedMediaModel)?.id ||
    availableModels[0]?.id ||
    selectedMediaModel;
  const selectedModel =
    effectiveComposerMode === "chat"
      ? selectedChatModel
      : resolvedMediaModel;
  const chat = useChatStream({
    activeSession: workspace.activeSession,
    activeProject: workspace.activeProject,
    messages: workspace.messages,
    setMessages: workspace.setMessages,
    setSessions: workspace.setSessions,
    persistSession: workspace.persistSession,
    apiKeys: apiKey.apiKeys,
    endpointOverrides: apiKey.endpointOverrides,
    selectedModel: selectedChatModel,
    codeAgentMode,
    attachedFiles: composer.attachedFiles,
    isParsingFile: composer.isParsingFile,
    clearAfterSubmit: composer.clearAfterSubmit,
    agents: agentCoordinator,
  });
  const media = useMediaGeneration({
    activeSession: workspace.activeSession,
    messages: workspace.messages,
    setMessages: workspace.setMessages,
    setSessions: workspace.setSessions,
    persistSession: workspace.persistSession,
    apiKeys: apiKey.apiKeys,
    endpointOverrides: apiKey.endpointOverrides,
    selectedModel: resolvedMediaModel,
    attachedFile: composer.attachedFiles[0] || null,
    typographyPolicy,
    imageEditFidelity,
    enableQualityGuard,
    isParsingFile: composer.isParsingFile,
    clearAfterSubmit: composer.clearAfterSubmit,
    agents: agentCoordinator,
  });
  const commerce = useCommerceResearch({
    activeSession: workspace.activeSession,
    messages: workspace.messages,
    setMessages: workspace.setMessages,
    setSessions: workspace.setSessions,
    persistSession: workspace.persistSession,
    apiKeys: apiKey.apiKeys,
    endpointOverrides: apiKey.endpointOverrides,
    serviceKeys: apiKey.serviceKeys,
    selectedModel: selectedChatModel,
    marketplace: commerceMarketplace,
    clearAfterSubmit: composer.clearAfterSubmit,
    agents: agentCoordinator,
  });
  const checkpointRuns = useCheckpointedAgentRuns({
    sessionId: workspace.activeSession?.id, sessionMode: workspace.activeSession?.mode,
    input: composer.input, attachments: composer.attachedFiles,
    selectedModel, composerMode: effectiveComposerMode, codeAgentMode,
    commerceWorkflowMode: commerce.workflowMode, commerceMarketplace,
    typographyPolicy, imageEditFidelity, enableQualityGuard,
    chat, media, commerce,
  });
  const isBusy =
    chat.isStreaming || media.isGenerating || commerce.isResearching;
  const activeStatus =
    workspace.activeSession?.mode === "commerce"
      ? commerce.agentStatus
      : media.status || chat.agentStatus;
  const activeUsage =
    workspace.activeSession?.mode === "commerce"
      ? commerce.tokenInfo
      : effectiveComposerMode === "chat"
        ? chat.tokenInfo
        : media.usageInfo;
  const activeToolActivities =
    workspace.activeSession?.mode === "commerce"
      ? commerce.toolActivities
      : chat.toolActivities;
  const resetConversationUi = () => {
    composer.resetComposer();
    chat.resetTransient();
    media.reset();
    commerce.reset();
    agentCoordinator.resetAgents();
  };

  const handleCreateSession = async (
    mode: SessionMode,
    projectId: string | null = null,
  ) => {
    if (isBusy) return;
    if (mode === "code" && !codePluginEnabled) {
      setShowPluginCenter(true);
      return;
    }
    if (mode === "commerce" && !commercePluginEnabled) {
      setShowPluginCenter(true);
      return;
    }
    if (mode === "media" && !mediaPluginEnabled) {
      setShowPluginCenter(true);
      return;
    }

    const session = await workspace.createSession(mode, projectId);
    if (session) resetConversationUi();
    if (mode === "code" || mode === "commerce" || mode === "media") {
      setComposerMode("chat");
    }
  };

  const handleSwitchSession = (id: string) => {
    if (isBusy) return;
    if (workspace.switchSession(id)) resetConversationUi();
  };

  const handleDeleteSession = async (
    id: string,
    event: MouseEvent,
  ) => {
    if (isBusy) return;
    const activeSessionChanged = await workspace.deleteSession(id, event);
    if (activeSessionChanged) resetConversationUi();
  };

  const handleAddProject = async () => {
    if (isBusy) return;
    if (!codePluginEnabled) {
      setShowPluginCenter(true);
      return;
    }
    const project = await workspace.addProject();
    if (project) {
      setComposerMode("chat");
      resetConversationUi();
    }
  };

  const handlePluginChange = (
    pluginId: BuiltinPluginId,
    enabled: boolean,
  ) => {
    plugins.setPluginEnabled(pluginId, enabled);

    // 如果用户关闭了当前正在查看的插件，立即回到核心 QA，避免页面停留在失效入口。
    const disabledMode =
      pluginId === "code-agent" ? "code" : "commerce";
    if (!enabled && workspace.activeSession?.mode === disabledMode) {
      const qaSession = workspace.sessions.find((session) => session.mode === "qa");
      if (qaSession) {
        handleSwitchSession(qaSession.id);
      } else {
        void handleCreateSession("qa");
      }
    }
  };

  const handleSelectModel = (modelId: string) => {
    if (effectiveComposerMode === "chat") {
      setSelectedChatModel(modelId);
    } else {
      setSelectedMediaModel(modelId);
    }
  };

  /**
   * 纯文字生成模式不会消费上传素材，因此切换到这些模式时清空旧附件，
   * 避免界面显示了素材但模型实际没有使用。
   */
  const handleComposerModeChange = (nextMode: ComposerMode) => {
    setComposerMode(nextMode);
    if (nextMode === "text-to-image" || nextMode === "text-to-video") {
      composer.setAttachedFiles([]);
      if (composer.fileInputRef.current) {
        composer.fileInputRef.current.value = "";
      }
    }
  };

  const handleSubmit = () => void checkpointRuns.submit();

  return (
    <main
      data-theme={theme}
      className="theme-transition relative flex h-screen flex-col overflow-hidden"
      style={{
        ...getThemeVariables(theme),
        background:
          "radial-gradient(circle at 72% 12%, var(--app-glow-blue), transparent 28%), radial-gradient(circle at 45% 95%, var(--app-glow-purple), transparent 30%), var(--app-bg)",
        color: "var(--text-primary)",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'SF Pro Text', 'Segoe UI', sans-serif",
      }}
    >
      {apiKey.showKeyModal && (
        <ApiKeyModal
          initialKeys={apiKey.apiKeys}
          initialEndpoints={apiKey.endpointOverrides}
          initialServiceKeys={apiKey.serviceKeys}
          onSave={apiKey.handleSaveKeys}
          onClose={apiKey.closeKeyModal}
        />
      )}
      {showPluginCenter && (
        <PluginCenter
          open
          plugins={plugins.manifests}
          enabled={plugins.enabled}
          onChange={handlePluginChange}
          onClose={() => setShowPluginCenter(false)}
        />
      )}

      <CustomTitleBar
        theme={theme}
        onToggleTheme={toggleTheme}
        runningAgentCount={agentCoordinator.runningAgentCount}
      />

      <div
        className="flex min-h-0 flex-1 border-t"
        style={{ borderColor: "var(--border)" }}
      >
        <ChatSidebar
          sessions={workspace.sessions}
          projects={workspace.projects}
          activeSessionId={workspace.activeSessionId}
          isStreaming={isBusy}
          createQaSession={() => void handleCreateSession("qa")}
          createCommerceSession={() => void handleCreateSession("commerce")}
          createMediaSession={() => void handleCreateSession("media")}
          createCodeSession={(projectId: string) =>
            void handleCreateSession("code", projectId)
          }
          addProject={() => void handleAddProject()}
          codePluginEnabled={codePluginEnabled}
          commercePluginEnabled={commercePluginEnabled}
          mediaPluginEnabled={mediaPluginEnabled}
          onOpenPluginCenter={() => setShowPluginCenter(true)}
          reindexProject={(projectId: string) =>
            void workspace.reindexProject(projectId)
          }
          switchSession={handleSwitchSession}
          deleteSession={(id: string, event: MouseEvent) =>
            void handleDeleteSession(id, event)
          }
        />

        <section className="relative flex min-w-0 flex-1 flex-col">
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-24"
            style={{
              background:
                "linear-gradient(180deg, color-mix(in srgb, var(--app-bg) 82%, transparent), transparent)",
            }}
          />

          <div className="relative mx-auto flex min-h-0 w-full max-w-[1480px] flex-1 flex-col px-5 pb-4 pt-4 lg:px-8">
            <WorkspaceHeader
              activeSession={workspace.activeSession}
              activeProject={workspace.activeProject}
              composerMode={effectiveComposerMode}
              tokenInfo={activeUsage}
              isStreaming={isBusy}
              onStop={
                commerce.isResearching
                  ? commerce.stop
                  : media.isGenerating
                    ? media.stop
                    : chat.stop
              }
              onOpenApiKey={apiKey.openKeyModal}
            />

            <div className="flex min-h-0 flex-1 gap-4">
              <div className="flex min-w-0 flex-1 flex-col">
                <ChatList
                  key={workspace.activeSessionId}
                  messages={workspace.messages}
                  isStreaming={isBusy}
                  toolActivities={activeToolActivities}
                  agentStatus={activeStatus}
                />

                <div className="shrink-0 pt-2">
                  {checkpointRuns.checkpoint && !isBusy && !chat.interactiveRequest ? (
                    <CheckpointResumeBar
                      checkpoint={checkpointRuns.checkpoint}
                      disabled={checkpointRuns.loading}
                      onResume={() => void checkpointRuns.resume(checkpointRuns.checkpoint!)}
                      onDiscard={() => void checkpointRuns.discard()}
                    />
                  ) : null}
                  {(workspace.activeSession?.mode === "code" ||
                    workspace.activeSession?.mode === "media") &&
                    chat.interactiveRequest &&
                    !isBusy && (
                    <InteractiveRequestPanel
                      request={chat.interactiveRequest}
                      answer={chat.interactiveAnswer}
                      onAnswerChange={chat.setInteractiveAnswer}
                      onReply={(
                        mode: "auto" | "llm" | "user",
                        answer?: string,
                      ) =>
                        void chat.handleInteractiveReply(mode, answer)
                      }
                    />
                  )}

                  <ChatComposer
                    mode={workspace.activeSession?.mode}
                    commerceMarketplace={commerceMarketplace}
                    commerceWorkflowMode={commerce.workflowMode}
                    onCommerceWorkflowModeChange={commerce.setWorkflowMode}
                    onCommerceMarketplaceChange={setCommerceMarketplace}
                    commerceDataSourceState={apiKey.commerceDataSourceState}
                    onOpenServiceSettings={apiKey.openKeyModal}
                    composerMode={effectiveComposerMode}
                    onComposerModeChange={handleComposerModeChange}
                    typographyPolicy={typographyPolicy}
                    onTypographyPolicyChange={setTypographyPolicy}
                    imageEditFidelity={imageEditFidelity}
                    onImageEditFidelityChange={setImageEditFidelity}
                    enableQualityGuard={enableQualityGuard}
                    onEnableQualityGuardChange={setEnableQualityGuard}
                    input={composer.input}
                    onInputChange={composer.setInput}
                    attachedFiles={composer.attachedFiles}
                    onRemoveFile={composer.removeAttachedFile}
                    onAddAttachments={composer.addAttachments}
                    attachmentError={composer.attachmentError}
                    isParsingFile={composer.isParsingFile}
                    isStreaming={isBusy}
                    fileInputRef={composer.fileInputRef}
                    models={availableModels}
                    selectedModel={selectedModel}
                    onSelectModel={handleSelectModel}
                    codeAgentMode={codeAgentMode}
                    onCodeAgentModeChange={setCodeAgentMode}
                    onCreateCustomModel={
                      effectiveComposerMode === "chat"
                        ? async (input) => {
                            const created = await customModels.createModel(input);
                            setSelectedChatModel(created.id);
                          }
                        : undefined
                    }
                    onUpdateCustomModel={
                      effectiveComposerMode === "chat"
                        ? customModels.updateModel
                        : undefined
                    }
                    onDeleteCustomModel={
                      effectiveComposerMode === "chat"
                        ? customModels.deleteModel
                        : undefined
                    }
                    onSubmit={handleSubmit}
                  />
                </div>
              </div>

              <aside className="hidden min-h-0 w-[360px] shrink-0 flex-col gap-4 xl:flex">
                <TaskPlanningPanel
                  agents={agentCoordinator.agents}
                  toolActivities={activeToolActivities}
                  lifecycleEvents={
                    workspace.activeSession?.mode === "commerce"
                      ? []
                      : chat.agentLifecycleEvents
                  }
                  workListSnapshot={
                    workspace.activeSession?.mode === "code"
                      ? chat.workListSnapshot
                      : null
                  }
                  agentStatus={activeStatus}
                  isStreaming={isBusy}
                  workflowMode={
                    workspace.activeSession?.mode === "commerce"
                      ? `commerce-${commerce.workflowMode}`
                      : workspace.activeSession?.mode === "media"
                        ? "media"
                      : effectiveComposerMode
                  }
                />
                <AgentPanel
                  agents={agentCoordinator.agents}
                  isStreaming={isBusy}
                  className="min-h-0 flex-1"
                />
              </aside>
            </div>
          </div>
        </section>
      </div>

    </main>
  );
}
