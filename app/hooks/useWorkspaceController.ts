// 模块说明：负责 useWorkspaceController 状态管理与业务编排。
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { MouseEvent } from "react";
import type {
  ChatSession,
  Message,
  SessionMode,
  WorkspaceProject,
} from "../constants/page-constants";
import { apiFetch } from "../lib/api-client";
import type { WorkspaceResponse } from "../types/workspace";
import { buildWelcomeMessages } from "../utilities/agent-runtime";

async function requestCreateSession(
  mode: SessionMode,
  projectId: string | null,
  project?: WorkspaceProject,
): Promise<ChatSession> {
  const initialMessages = buildWelcomeMessages(mode, project);
  const response = await apiFetch("/api/workspace", {
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

interface WorkspaceControllerOptions {
  includeCode?: boolean;
  includeCommerce?: boolean;
  includeMedia?: boolean;
}

export function useWorkspaceController(
  options: WorkspaceControllerOptions = {},
) {
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
    const params = new URLSearchParams();
    if (options.includeCode) params.set("code", "1");
    if (options.includeCommerce) params.set("commerce", "1");
    if (options.includeMedia) params.set("media", "1");
    const query = params.toString();
    const response = await apiFetch(`/api/workspace${query ? `?${query}` : ""}`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("无法读取本地工作区数据");

    const workspace = (await response.json()) as WorkspaceResponse;
    setProjects(workspace.projects);
    setSessions(workspace.sessions);
    return workspace;
  }, [options.includeCode, options.includeCommerce, options.includeMedia]);

  const createSession = useCallback(
    async (
      mode: SessionMode,
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

        // 插件化后，应用启动始终优先恢复核心 QA，而不是最近一次 Code / Commerce 会话。
        // 这样首屏不会因为上次停留在重型 Agent 而立即进入插件工作流。
        const qaSession = workspace.sessions.find((session) => session.mode === "qa");
        if (qaSession) {
          setActiveSessionId(qaSession.id);
          setMessages(qaSession.messages);
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
      const response = await apiFetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "updateSession",
          id: session.id,
          title,
          messages: nextMessages,
        }),
      });
      // 旧版忽略非 2xx 响应，界面看似保存成功，重启后才发现消息没有写入 SQLite。
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          error?: string;
        };
        throw new Error(payload.error || `会话保存失败：HTTP ${response.status}`);
      }
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

      const response = await apiFetch("/api/workspace", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deleteSession", id }),
      });
      if (!response.ok) {
        throw new Error(`删除会话失败：HTTP ${response.status}`);
      }

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
        const response = await apiFetch(`/api/projects/${projectId}/index`, {
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
      const rootPath = await window.electronAPI?.selectFolder?.();
      if (!rootPath) return null;

      const response = await apiFetch("/api/workspace", {
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
