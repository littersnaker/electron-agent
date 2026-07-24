"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type {
  ChatSession,
  Message,
} from "../const/pageConst";
import type {
  CommerceMarketplaceCode,
  CommerceProgressEvent,
  CommerceResearchReport,
} from "../lib/commerce/types";
import { buildLlmRequestHeaders } from "../lib/llm/client-request";
import type { LlmCredentials } from "../lib/llm/types";
import {
  buildCommerceCredentialHeaders,
  type AuxiliaryServiceCredentials,
} from "../lib/service-credentials";
import type { StreamPacket, TokenInfo, ToolActivity } from "../types/workspace";
import type { AgentCoordinator } from "./useAgentCoordinator";

interface UseCommerceResearchOptions {
  activeSession?: ChatSession;
  messages: Message[];
  setMessages: Dispatch<SetStateAction<Message[]>>;
  setSessions: Dispatch<SetStateAction<ChatSession[]>>;
  persistSession: (
    session: ChatSession,
    nextMessages: Message[],
    title?: string,
  ) => Promise<void>;
  apiKeys: LlmCredentials;
  serviceKeys: AuxiliaryServiceCredentials;
  selectedModel: string;
  marketplace: CommerceMarketplaceCode;
  clearAfterSubmit: () => void;
  agents: AgentCoordinator;
}

const STAGE_LABELS: Record<CommerceProgressEvent["stage"], string> = {
  intent: "理解市场目标",
  category: "生成市场检索计划",
  collect: "采集公开市场信号",
  normalize: "统一市场观察",
  analyze: "计算市场信号",
  strategy: "生成情报结论",
  done: "完成市场情报报告",
};

async function readResponseError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: unknown };
    if (typeof payload.error === "string" && payload.error.trim()) {
      return payload.error;
    }
  } catch {
    // 非 JSON 错误响应使用状态码兜底。
  }
  return `跨境市场情报请求失败（HTTP ${response.status}）`;
}

function isCommerceProgressEvent(
  value: StreamPacket["payload"],
): value is CommerceProgressEvent {
  return Boolean(
    value &&
      "stage" in value &&
      "progress" in value &&
      "detail" in value,
  );
}

function isCommerceResearchReport(
  value: StreamPacket["payload"],
): value is CommerceResearchReport {
  return Boolean(
    value &&
      "version" in value &&
      (value.version === 2 || value.version === 3) &&
      "metrics" in value &&
      "products" in value &&
      "category" in value,
  );
}

/**
 * Cross-border Market Intelligence Agent 使用独立 Hook 与独立 API Route。
 *
 * 它只复用“会话持久化、模型 Key、Agent 面板”这些基础设施，不进入 QA Route，
 * 因此后续加入竞品监控、关键词研究或其他平台时不会继续膨胀 QA 逻辑。
 */
export function useCommerceResearch({
  activeSession,
  messages,
  setMessages,
  setSessions,
  persistSession,
  apiKeys,
  serviceKeys,
  selectedModel,
  marketplace,
  clearAfterSubmit,
  agents,
}: UseCommerceResearchOptions) {
  const [isResearching, setIsResearching] = useState(false);
  const [agentStatus, setAgentStatus] = useState("");
  const [tokenInfo, setTokenInfo] = useState<TokenInfo | null>(null);
  const [toolActivities, setToolActivities] = useState<ToolActivity[]>([]);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback(() => {
    setAgentStatus("");
    setTokenInfo(null);
    setToolActivities([]);
  }, []);

  const submitPrompt = useCallback(
    async (promptText: string) => {
      if (
        !activeSession ||
        activeSession.mode !== "commerce" ||
        isResearching
      ) {
        return;
      }

      const query = promptText.trim();
      if (!query) return;

      const userMessage: Message = { role: "user", content: query };
      const optimisticHistory: Message[] = [
        ...messages,
        userMessage,
        { role: "assistant", content: "" },
      ];
      const title =
        activeSession.title === "新对话"
          ? query.slice(0, 18) || "市场研究"
          : activeSession.title;

      setMessages(optimisticHistory);
      setSessions((current: ChatSession[]) =>
        current.map((session: ChatSession) =>
          session.id === activeSession.id
            ? { ...session, title, messages: optimisticHistory }
            : session,
        ),
      );
      void persistSession(activeSession, optimisticHistory, title);
      clearAfterSubmit();

      setIsResearching(true);
      setAgentStatus("正在理解你的市场研究目标…");
      setTokenInfo(null);
      setToolActivities([]);
      agents.beginCommerceRun();

      const abortController = new AbortController();
      abortRef.current = abortController;
      let finalText = "";
      let finalReport: CommerceResearchReport | undefined;
      let runFailed = false;

      try {
        const headers = {
          ...buildLlmRequestHeaders(apiKeys, selectedModel),
          ...buildCommerceCredentialHeaders(serviceKeys),
        };

        const response = await fetch("/api/commerce/research", {
          method: "POST",
          headers,
          body: JSON.stringify({
            query,
            marketplace,
            sampleSize: 24,
            messages: messages
              .filter((message) => Boolean(message.content.trim()))
              .slice(-8)
              .map(({ role, content }) => ({ role, content })),
          }),
          signal: abortController.signal,
        });

        if (!response.ok || !response.body) {
          throw new Error(await readResponseError(response));
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split(/\r?\n/u);
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            try {
              const packet = JSON.parse(line.slice(5).trim()) as StreamPacket;

              if (
                packet.type === "COMMERCE_PROGRESS" &&
                isCommerceProgressEvent(packet.payload)
              ) {
                const event = packet.payload;
                const now = Date.now();
                setAgentStatus(event.detail);
                agents.updateCommerceProgress(event);
                setToolActivities((current: ToolActivity[]) => {
                  const completed = current.map((activity: ToolActivity) =>
                    activity.status === "running"
                      ? {
                          ...activity,
                          status: "completed" as const,
                          endedAt: now,
                        }
                      : activity,
                  );
                  if (event.stage === "done") return completed;
                  return [
                    ...completed,
                    {
                      id: `commerce_${event.stage}_${now}`,
                      label: STAGE_LABELS[event.stage],
                      status: "running" as const,
                      startedAt: now,
                    },
                  ].slice(-8);
                });
                continue;
              }

              if (
                packet.type === "COMMERCE_REPORT" &&
                isCommerceResearchReport(packet.payload)
              ) {
                finalReport = packet.payload;
                setMessages((current: Message[]) => [
                  ...current.slice(0, -1),
                  {
                    role: "assistant",
                    content: finalText,
                    commerceReport: finalReport,
                  },
                ]);
                continue;
              }

              if (packet.type === "AGENT_ERROR" && packet.agent) {
                const detail =
                  packet.agent.currentTask ||
                  packet.agent.task ||
                  "Cross-border Market Intelligence Agent 执行失败";
                runFailed = true;
                setAgentStatus(detail);
                agents.failCommerceRun(detail);
                const now = Date.now();
                setToolActivities((current: ToolActivity[]) =>
                  current.map((activity: ToolActivity) =>
                    activity.status === "running"
                      ? {
                          ...activity,
                          status: "error" as const,
                          endedAt: now,
                        }
                      : activity,
                  ),
                );
                continue;
              }

              if (packet.type === "TEXT" && typeof packet.content === "string") {
                finalText += packet.content;
                setMessages((current: Message[]) => [
                  ...current.slice(0, -1),
                  {
                    role: "assistant",
                    content: finalText,
                    commerceReport: finalReport,
                  },
                ]);
                continue;
              }

              if (
                packet.type === "STATUS" &&
                typeof packet.content === "string"
              ) {
                setAgentStatus(packet.content);
                continue;
              }

              if (
                packet.type === "USAGE" &&
                packet.content &&
                typeof packet.content !== "string"
              ) {
                setTokenInfo(packet.content);
              }
            } catch {
              // 不完整 SSE 帧等待下一次网络分片补齐，不影响当前研究任务。
            }
          }
        }
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          const message =
            error instanceof Error ? error.message : "Cross-border Market Intelligence Agent 请求失败";
          runFailed = true;
          finalText ||= `⚠️ ${message}`;
          agents.failCommerceRun(message);
        }
      } finally {
        const now = Date.now();
        setToolActivities((current: ToolActivity[]) =>
          current.map((activity: ToolActivity) =>
            activity.status === "running"
              ? {
                  ...activity,
                  status: runFailed
                    ? ("error" as const)
                    : ("completed" as const),
                  endedAt: now,
                }
              : activity,
          ),
        );

        const answer = finalText || "已停止市场研究。";
        const finalHistory: Message[] = [
          ...optimisticHistory.slice(0, -1),
          {
            role: "assistant",
            content: answer,
            commerceReport: finalReport,
          },
        ];
        setMessages(finalHistory);
        setSessions((current: ChatSession[]) =>
          current.map((session: ChatSession) =>
            session.id === activeSession.id
              ? { ...session, title, messages: finalHistory }
              : session,
          ),
        );
        void persistSession(activeSession, finalHistory, title);
        setIsResearching(false);
        setAgentStatus("");
        abortRef.current = null;
      }
    },
    [
      activeSession,
      agents,
      apiKeys,
      clearAfterSubmit,
      isResearching,
      marketplace,
      messages,
      persistSession,
      selectedModel,
      serviceKeys,
      setMessages,
      setSessions,
    ],
  );

  return {
    isResearching,
    agentStatus,
    tokenInfo,
    toolActivities,
    submitPrompt,
    stop,
    reset,
  };
}
