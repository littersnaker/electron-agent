"use client";

import { useState } from "react";
import type { MouseEvent } from "react";
import AgentPanel from "./component/AgentPanel";
import ApiKeyModal from "./component/ApiKeyModal";
import ChatComposer from "./component/ChatComposer";
import ChatList from "./component/ChatList";
import ChatSidebar from "./component/ChatSidebar";
import CustomTitleBar from "./component/CustomTitleBar";
import InteractiveRequestPanel from "./component/InteractiveRequestPanel";
import WorkspaceHeader from "./component/WorkspaceHeader";
import { AVAILABLE_MODELS } from "./const/modelList";
import { getThemeVariables } from "./const/theme";
import { useAgentCoordinator } from "./hooks/useAgentCoordinator";
import { useApiKey } from "./hooks/useApiKey";
import { useChatStream } from "./hooks/useChatStream";
import { useComposer } from "./hooks/useComposer";
import { useThemeMode } from "./hooks/useThemeMode";
import { useWorkspaceController } from "./hooks/useWorkspaceController";

export default function Home() {
  const [selectedModel, setSelectedModel] = useState(
    "qwen3.7-max-2026-05-20",
  );
  const { theme, toggleTheme } = useThemeMode();
  const apiKey = useApiKey();
  const composer = useComposer();
  const workspace = useWorkspaceController();
  const agentCoordinator = useAgentCoordinator();
  const chat = useChatStream({
    activeSession: workspace.activeSession,
    activeProject: workspace.activeProject,
    messages: workspace.messages,
    setMessages: workspace.setMessages,
    setSessions: workspace.setSessions,
    persistSession: workspace.persistSession,
    apiKey: apiKey.apiKey,
    selectedModel,
    attachedFile: composer.attachedFile,
    isParsingFile: composer.isParsingFile,
    setInput: composer.setInput,
    clearAfterSubmit: composer.clearAfterSubmit,
    fileInputRef: composer.fileInputRef,
    agents: agentCoordinator,
  });

  const resetConversationUi = () => {
    composer.resetComposer();
    chat.resetTransient();
    agentCoordinator.resetAgents();
  };

  const handleCreateSession = async (
    mode: "qa" | "code",
    projectId: string | null = null,
  ) => {
    if (chat.isStreaming) return;
    const session = await workspace.createSession(mode, projectId);
    if (session) resetConversationUi();
  };

  const handleSwitchSession = (id: string) => {
    if (chat.isStreaming) return;
    if (workspace.switchSession(id)) resetConversationUi();
  };

  const handleDeleteSession = async (id: string, event: MouseEvent) => {
    if (chat.isStreaming) return;
    const activeSessionChanged = await workspace.deleteSession(id, event);
    if (activeSessionChanged) resetConversationUi();
  };

  const handleAddProject = async () => {
    if (chat.isStreaming) return;
    const project = await workspace.addProject();
    if (project) resetConversationUi();
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
      <ApiKeyModal
        isOpen={apiKey.showKeyModal}
        onSave={apiKey.handleSaveKey}
      />
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
          isStreaming={chat.isStreaming}
          createQaSession={() => void handleCreateSession("qa")}
          createCodeSession={(projectId) =>
            void handleCreateSession("code", projectId)
          }
          addProject={() => void handleAddProject()}
          reindexProject={(projectId) =>
            void workspace.reindexProject(projectId)
          }
          switchSession={handleSwitchSession}
          deleteSession={(id, event) =>
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
              tokenInfo={chat.tokenInfo}
              isStreaming={chat.isStreaming}
              onStop={chat.stop}
              onOpenApiKey={apiKey.openKeyModal}
            />

            <div className="flex min-h-0 flex-1 gap-4">
              <div className="flex min-w-0 flex-1 flex-col">
                <ChatList
                  key={workspace.activeSessionId}
                  messages={workspace.messages}
                  isStreaming={chat.isStreaming}
                  toolActivities={chat.toolActivities}
                  agentStatus={chat.agentStatus}
                />

                <div className="shrink-0 pt-2">
                  {chat.interactiveRequest && !chat.isStreaming && (
                    <InteractiveRequestPanel
                      request={chat.interactiveRequest}
                      answer={chat.interactiveAnswer}
                      onAnswerChange={chat.setInteractiveAnswer}
                      onReply={(mode, answer) =>
                        void chat.handleInteractiveReply(mode, answer)
                      }
                    />
                  )}

                  <ChatComposer
                    mode={workspace.activeSession?.mode}
                    input={composer.input}
                    onInputChange={composer.setInput}
                    attachedFile={composer.attachedFile}
                    onRemoveFile={() => composer.setAttachedFile(null)}
                    isParsingFile={composer.isParsingFile}
                    isStreaming={chat.isStreaming}
                    fileInputRef={composer.fileInputRef}
                    onFileSelect={composer.handleFileSelect}
                    models={AVAILABLE_MODELS}
                    selectedModel={selectedModel}
                    onSelectModel={setSelectedModel}
                    onSubmit={() => void chat.submitPrompt(composer.input)}
                  />
                </div>
              </div>

              <AgentPanel
                agents={agentCoordinator.agents}
                isStreaming={chat.isStreaming}
                className="hidden xl:flex"
              />
            </div>
          </div>
        </section>
      </div>

      <style jsx global>{`
        * {
          scrollbar-width: thin;
          scrollbar-color: var(--scrollbar-thumb) transparent;
        }

        *::-webkit-scrollbar {
          width: 8px;
          height: 8px;
        }

        *::-webkit-scrollbar-track {
          background: transparent;
        }

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

        button,
        input,
        textarea {
          font: inherit;
        }

        .theme-transition {
          transition:
            background 300ms var(--ease-apple),
            color 260ms var(--ease-apple);
        }
      `}</style>
    </main>
  );
}
