"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../lib/api-client";
import type {
  AgentCheckpoint,
  AgentCheckpointKind,
  AgentCheckpointRequest,
  AgentCheckpointStatus,
} from "../types/checkpoints";

interface CheckpointEnvelope {
  checkpoint?: AgentCheckpoint | null;
}

interface BeginInput {
  agentKind: AgentCheckpointKind;
  route: string;
  request: AgentCheckpointRequest;
  label: string;
}

/** 管理当前会话的持久化 Agent Checkpoint。 */
export function useAgentCheckpoints(sessionId?: string) {
  const [checkpoint, setCheckpoint] = useState<AgentCheckpoint | null>(null);
  const [loading, setLoading] = useState(false);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setCheckpoint(null);
      return null;
    }
    setLoading(true);
    try {
      const response = await apiFetch(
        `/api/checkpoints/latest?sessionId=${encodeURIComponent(sessionId)}`,
      );
      const payload = (await response.json()) as CheckpointEnvelope;
      const next = response.ok ? payload.checkpoint || null : null;
      if (sessionRef.current === sessionId) setCheckpoint(next);
      return next;
    } catch (error) {
      console.warn("[Checkpoint] 暂时无法读取恢复点", error);
      if (sessionRef.current === sessionId) setCheckpoint(null);
      return null;
    } finally {
      if (sessionRef.current === sessionId) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const begin = useCallback(
    async (input: BeginInput): Promise<AgentCheckpoint> => {
      if (!sessionId) throw new Error("当前会话不存在，无法创建 Checkpoint");
      const response = await apiFetch("/api/checkpoints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, ...input }),
      });
      const payload = (await response.json()) as CheckpointEnvelope & {
        error?: string;
      };
      if (!response.ok || !payload.checkpoint) {
        throw new Error(payload.error || "创建 Checkpoint 失败");
      }
      setCheckpoint(payload.checkpoint);
      return payload.checkpoint;
    },
    [sessionId],
  );

  const update = useCallback(
    async (
      checkpointId: string,
      status: AgentCheckpointStatus,
      errorMessage = "",
      request?: AgentCheckpointRequest,
    ) => {
      try {
        const response = await apiFetch(`/api/checkpoints/${checkpointId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status,
            errorMessage,
            request,
            resumable: !["completed", "discarded"].includes(status),
          }),
        });
        const payload = (await response.json()) as CheckpointEnvelope;
        if (response.ok && payload.checkpoint) {
          setCheckpoint(payload.checkpoint.resumable ? payload.checkpoint : null);
        }
      } catch (error) {
        // 应用关闭或后端重启期间，保留 SQLite 中最后一次安全快照即可。
        console.warn("[Checkpoint] 状态更新暂时失败", error);
      }
    },
    [],
  );

  const discard = useCallback(async (checkpointId: string) => {
    try {
      await apiFetch(`/api/checkpoints/${checkpointId}`, { method: "DELETE" });
      setCheckpoint((current) =>
        current?.id === checkpointId ? null : current,
      );
    } catch (error) {
      console.warn("[Checkpoint] 删除失败", error);
    }
  }, []);

  return {
    checkpoint,
    loading,
    begin,
    refresh,
    update,
    discard,
  };
}

export type AgentCheckpointController = ReturnType<typeof useAgentCheckpoints>;
