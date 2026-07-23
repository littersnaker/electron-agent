"use client";

import { useMemo, useState } from "react";
import type { MouseEvent } from "react";
import AgentPanel from "./component/AgentPanel";
import ApiKeyModal from "./component/ApiKeyModal";
import ChatComposer from "./component/ChatComposer";
import ChatList from "./component/ChatList";
import ChatSidebar from "./component/ChatSidebar";
import CustomTitleBar from "./component/CustomTitleBar";
import InteractiveRequestPanel from "./component/InteractiveRequestPanel";
import TaskPlanningPanel from "./component/TaskPlanningPanel";
import WorkspaceHeader from "./component/WorkspaceHeader";
import {
  AVAILABLE_CHAT_MODELS,
  getAvailableMediaModelOptions,
} from "./const/modelList";
import type {
  ComposerMode,
  ImageEditFidelity,
  MediaMode,
  TypographyPolicy,
} from "./const/pageConst";
import { getThemeVariables } from "./const/theme";
import { useAgentCoordinator } from "./hooks/useAgentCoordinator";
import { useApiKey } from "./hooks/useApiKey";
import { useChatStream } from "./hooks/useChatStream";
import { useComposer } from "./hooks/useComposer";
import { useMediaGeneration } from "./hooks/useMediaGeneration";
import { useThemeMode } from "./hooks/useThemeMode";
import { useWorkspaceController } from "./hooks/useWorkspaceController";
import { AUTO_MODEL_ID } from "./lib/llm/model-catalog";
import { DEFAULT_MEDIA_MODEL_ID } from "./lib/media/catalog";

/**
 * 白雪条工作台页面入口。
 *
 * 普通聊天仍走原有 LLM Gateway；图片/视频生成走独立 Media Route。
 * 这样不会把异步媒体协议塞进 Code Agent 的文本 SSE 工作流。
 */
export default function Home() {
  const [composerMode, setComposerMode] = useState<ComposerMode>("chat");
  const [selectedChatModel, setSelectedChatModel] = useState(AUTO_MODEL_ID);
  const [selectedMediaModel, setSelectedMediaModel] = useState(
    DEFAULT_MEDIA_MODEL_ID,
  );
  const [typographyPolicy, setTypographyPolicy] =
    useState<TypographyPolicy>("avoid-generated-text");
  const [imageEditFidelity, setImageEditFidelity] =
    useState<ImageEditFidelity>("precise");
  const [enableQualityGuard, setEnableQualityGuard] = useState(true);
  const { theme, toggleTheme } = useThemeMode();
  const apiKey = useApiKey();
  const composer = useComposer();
  const workspace = useWorkspaceController();
  const agentCoordinator = useAgentCoordinator();

  const effectiveComposerMode: ComposerMode =
    workspace.activeSession?.mode === "code" ? "chat" : composerMode;

  const availableModels = useMemo(() => {
    if (effectiveComposerMode === "chat") return AVAILABLE_CHAT_MODELS;
    return getAvailableMediaModelOptions(effectiveComposerMode);
  }, [effectiveComposerMode]);

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
    selectedModel: selectedChatModel,
    attachedFile: composer.attachedFile,
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
    selectedModel: resolvedMediaModel,
    attachedFile: composer.attachedFile,
    typographyPolicy,
    imageEditFidelity,
    enableQualityGuard,
    isParsingFile: composer.isParsingFile,
    clearAfterSubmit: composer.clearAfterSubmit,
    agents: agentCoordinator,
  });

  const isBusy = chat.isStreaming || media.isGenerating;
  const activeStatus = media.status || chat.agentStatus;
  const activeUsage =
    effectiveComposerMode === "chat" ? chat.tokenInfo : media.usageInfo;

  const resetConversationUi = () => {
    composer.resetComposer();
    chat.resetTransient();
    media.reset();
    agentCoordinator.resetAgents();
  };

  const handleCreateSession = async (
    mode: "qa" | "code",
    projectId: string | null = null,
  ) => {
    if (isBusy) return;
    const session = await workspace.createSession(mode, projectId);
    if (session) resetConversationUi();
    if (mode === "code") setComposerMode("chat");
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
    const project = await workspace.addProject();
    if (project) {
      setComposerMode("chat");
      resetConversationUi();
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
      composer.setAttachedFile(null);
      if (composer.fileInputRef.current) {
        composer.fileInputRef.current.value = "";
      }
    }
  };

  const handleSubmit = () => {
    if (effectiveComposerMode === "chat") {
      void chat.submitPrompt(composer.input);
      return;
    }
    void media.submit(composer.input, effectiveComposerMode as MediaMode);
  };

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
          onSave={apiKey.handleSaveKeys}
          onClose={apiKey.closeKeyModal}
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
          createCodeSession={(projectId: string) =>
            void handleCreateSession("code", projectId)
          }
          addProject={() => void handleAddProject()}
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
              onStop={media.isGenerating ? media.stop : chat.stop}
              onOpenApiKey={apiKey.openKeyModal}
            />

            <div className="flex min-h-0 flex-1 gap-4">
              <div className="flex min-w-0 flex-1 flex-col">
                <ChatList
                  key={workspace.activeSessionId}
                  messages={workspace.messages}
                  isStreaming={isBusy}
                  toolActivities={chat.toolActivities}
                  agentStatus={activeStatus}
                />

                <div className="shrink-0 pt-2">
                  {chat.interactiveRequest && !isBusy && (
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
                    attachedFile={composer.attachedFile}
                    onRemoveFile={() => composer.setAttachedFile(null)}
                    isParsingFile={composer.isParsingFile}
                    isStreaming={isBusy}
                    fileInputRef={composer.fileInputRef}
                    onFileSelect={composer.handleFileSelect}
                    models={availableModels}
                    selectedModel={selectedModel}
                    onSelectModel={handleSelectModel}
                    onSubmit={handleSubmit}
                  />
                </div>
              </div>

              <aside className="hidden min-h-0 w-[360px] shrink-0 flex-col gap-4 xl:flex">
                <TaskPlanningPanel
                  agents={agentCoordinator.agents}
                  toolActivities={chat.toolActivities}
                  agentStatus={activeStatus}
                  isStreaming={isBusy}
                  workflowMode={effectiveComposerMode}
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

      <style jsx global>{`
        * {
          scrollbar-width: thin;
          scrollbar-color: var(--scrollbar-thumb) transparent;
        }
        *::-webkit-scrollbar { width: 8px; height: 8px; }
        *::-webkit-scrollbar-track { background: transparent; }
        *::-webkit-scrollbar-thumb {
          background: var(--scrollbar-thumb);
          border: 2px solid transparent;
          background-clip: padding-box;
          border-radius: 999px;
        }
        body {
          margin: 0;
          background: var(--app-bg);
          transition: background-color 300ms var(--ease-apple);
        }
        button, input, textarea { font: inherit; }
        .theme-transition {
          transition:
            background 300ms var(--ease-apple),
            color 260ms var(--ease-apple);
        }
      `}</style>
    </main>
  );
}
