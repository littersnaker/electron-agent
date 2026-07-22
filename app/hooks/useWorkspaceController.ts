"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import type {
  ChatSession,
  Message,
  WorkspaceProject,
} from "../const/pageConst";
import type { WorkspaceResponse } from "../types/workspace";
import { buildWelcomeMessages } from "../utils/agentRuntime";

async function requestCreateSession(
  mode: "qa" | "code",
  projectId: string | null,
  project?: WorkspaceProject,
): Promise<ChatSession> {
  const initialMessages = buildWelcomeMessages(mode, project);
  const response = await fetch("/api/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "createSession",
      mode,
      projectId,
      title: "新对话",
      messages: initialMessages,
    }),
  });

  if (!response.ok) {
    throw new Error((await response.json()).error || "创建会话失败");
  }

  const { session } = (await response.json()) as { session: ChatSession };
  return session;
}

export function useWorkspaceController() {
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId),
    [activeSessionId, sessions],
  );

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeSession?.projectId),
    [activeSession?.projectId, projects],
  );

  const refreshWorkspace = useCallback(async (): Promise<WorkspaceResponse> => {
    const response = await fetch("/api/workspace", { cache: "no-store" });
    if (!response.ok) throw new Error("无法读取本地工作区数据");

    const workspace = (await response.json()) as WorkspaceResponse;
    setProjects(workspace.projects);
    setSessions(workspace.sessions);
    return workspace;
  }, []);

  const createSession = useCallback(
    async (
      mode: "qa" | "code",
      projectId: string | null = null,
      projectOverride?: WorkspaceProject,
    ) => {
      if (mode === "code" && !projectId) return null;

      const project =
        projectOverride || projects.find((item) => item.id === projectId);
      const session = await requestCreateSession(mode, projectId, project);

      setSessions((current) => [session, ...current]);
      setActiveSessionId(session.id);
      setMessages(session.messages);
      return session;
    },
    [projects],
  );

  useEffect(() => {
    let cancelled = false;

    const initialize = async () => {
      try {
        const workspace = await refreshWorkspace();
        if (cancelled) return;

        if (workspace.sessions.length) {
          setActiveSessionId(workspace.sessions[0].id);
          setMessages(workspace.sessions[0].messages);
          return;
        }

        const session = await requestCreateSession("qa", null);
        if (cancelled) return;

        setSessions([session]);
        setActiveSessionId(session.id);
        setMessages(session.messages);
      } catch (error) {
        console.error(error);
      }
    };

    void initialize();
    return () => {
      cancelled = true;
    };
  }, [refreshWorkspace]);

  const persistSession = useCallback(
    async (
      session: ChatSession,
      nextMessages: Message[],
      title = session.title,
    ) => {
      await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "updateSession",
          id: session.id,
          title,
          messages: nextMessages,
        }),
      });
    },
    [],
  );

  const switchSession = useCallback(
    (id: string) => {
      if (id === activeSessionId) return false;

      const session = sessions.find((item) => item.id === id);
      if (!session) return false;

      setActiveSessionId(id);
      setMessages(session.messages);
      return true;
    },
    [activeSessionId, sessions],
  );

  const deleteSession = useCallback(
    async (id: string, event: MouseEvent) => {
      event.stopPropagation();
      const remaining = sessions.filter((session) => session.id !== id);

      await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deleteSession", id }),
      });

      setSessions(remaining);

      if (activeSessionId !== id) return false;

      if (remaining[0]) {
        setActiveSessionId(remaining[0].id);
        setMessages(remaining[0].messages);
      } else {
        const session = await requestCreateSession("qa", null);
        setSessions([session]);
        setActiveSessionId(session.id);
        setMessages(session.messages);
      }

      return true;
    },
    [activeSessionId, sessions],
  );

  const reindexProject = useCallback(
    async (projectId: string) => {
      setProjects((current) =>
        current.map((project) =>
          project.id === projectId
            ? { ...project, indexStatus: "indexing" }
            : project,
        ),
      );

      try {
        const response = await fetch(`/api/projects/${projectId}/index`, {
          method: "POST",
        });
        if (!response.ok) throw new Error("索引失败");
        await refreshWorkspace();
      } catch (error) {
        console.error(error);
        setProjects((current) =>
          current.map((project) =>
            project.id === projectId
              ? { ...project, indexStatus: "error" }
              : project,
          ),
        );
      }
    },
    [refreshWorkspace],
  );

  const addProject = useCallback(async () => {
    try {
      // @ts-expect-error Electron preload API is injected at runtime.
      const rootPath = await window.electronAPI?.selectFolder?.();
      if (!rootPath) return null;

      const response = await fetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "createProject", rootPath }),
      });

      if (!response.ok) {
        throw new Error((await response.json()).error || "添加项目失败");
      }

      const { project } = (await response.json()) as {
        project: WorkspaceProject;
      };

      await refreshWorkspace();
      await createSession("code", project.id, project);
      void reindexProject(project.id);
      return project;
    } catch (error) {
      console.error(error);
      return null;
    }
  }, [createSession, refreshWorkspace, reindexProject]);

  return {
    projects,
    sessions,
    activeSessionId,
    activeSession,
    activeProject,
    messages,
    setMessages,
    setSessions,
    createSession,
    persistSession,
    switchSession,
    deleteSession,
    reindexProject,
    addProject,
  };
}

export type WorkspaceController = ReturnType<typeof useWorkspaceController>;
