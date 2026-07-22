import type { BaseMessage } from "@langchain/core/messages";
import { runWithLlmCredentials } from "@/app/lib/llm/request-context";
import type { LlmCredentials } from "@/app/lib/llm/types";
import { graph } from "../agent/graph";
import { emitGraphUpdateStatus, formatLifecycleStatus } from "./graph-status";
import { sendSse } from "./sse";
import type { SseController } from "./sse";
import type {
  AgentLifecycleEventPayload,
  AgentStateValues,
} from "./types";

interface RunAgentGraphOptions {
  inputMessages: BaseMessage[];
  sessionId: string;
  model: string;
  workingDir: string;
  projectId: string;
  llmCredentials: LlmCredentials;
  controller: SseController;
  encoder: TextEncoder;
}

/**
 * 运行 LangGraph 并把节点状态实时转换成 SSE。
 *
 * 模型凭证通过 AsyncLocalStorage 保存在当前请求的异步上下文中，
 * 不进入 LangGraph State，也不会被 Checkpointer 写入 SQLite。
 * 旧线程只补最近两条消息，避免每轮把完整历史重复写入 Checkpoint。
 */
export async function runAgentGraph({
  inputMessages,
  sessionId,
  model,
  workingDir,
  projectId,
  llmCredentials,
  controller,
  encoder,
}: RunAgentGraphOptions): Promise<AgentStateValues> {
  return runWithLlmCredentials(llmCredentials, async () => {
    const snapshot = await graph.getState({
      configurable: { thread_id: sessionId },
    });
    const hasExistingState = (snapshot.values?.messages?.length || 0) > 0;
    const messagesToGraph = hasExistingState
      ? inputMessages.slice(-2)
      : inputMessages;

    const stream = await graph.stream(
      {
        messages: messagesToGraph,
        model,
        workingDir,
        projectId,
      },
      {
        configurable: {
          thread_id: sessionId,
          working_dir: workingDir,
        },
        recursionLimit: 80,
        streamMode: ["updates", "custom"],
      },
    );

    let lastNodeTimestamp = performance.now();

    for await (const streamChunk of stream) {
      const [mode, chunk] = streamChunk as [string, unknown];

      if (mode === "custom") {
        const custom = chunk as {
          type?: string;
          payload?: AgentLifecycleEventPayload;
        };
        if (custom.type === "AGENT_LIFECYCLE" && custom.payload) {
          sendSse(controller, encoder, {
            type: "AGENT_LIFECYCLE",
            payload: custom.payload,
          });
          sendSse(controller, encoder, {
            type: "STATUS",
            content: `🔄 ${formatLifecycleStatus(custom.payload)}`,
          });
        }
        continue;
      }

      const updates = chunk as Record<string, Record<string, unknown>>;
      const now = performance.now();
      const elapsedSeconds = ((now - lastNodeTimestamp) / 1000).toFixed(1);
      lastNodeTimestamp = now;
      emitGraphUpdateStatus(
        updates,
        elapsedSeconds,
        controller,
        encoder,
      );
    }

    const finalSnapshot = await graph.getState({
      configurable: { thread_id: sessionId },
    });
    return finalSnapshot.values as AgentStateValues;
  });
}
