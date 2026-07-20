import { BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer, // 👈 必须用这个，才能正确处理 RemoveMessage 和 ID 查重
    default: () => [],
  }),
  model: Annotation<string>,
  // ⚡ 新增：用于滚动记录历史压缩摘要，极大地节约 Token
  summary: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  routeDecision: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "NO_TOOL",
  }),
  pendingDiffResult: Annotation<string | null>({
    reducer: (x, y) => y ?? x,
    default: () => null,
  }),
  workingDir: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  projectId: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  apiKey: Annotation<string>({
    reducer: (x, y) => y ?? x,
    default: () => "",
  }),
  // ⚡ 新增全局 Token 累加器 (自动累加各节点的消耗)
  tokenUsage: Annotation<{ prompt: number; completion: number; total: number }>({
    reducer: (currentState, newValue) => {
      if (!newValue) return currentState;
      return {
        prompt: currentState.prompt + (newValue.prompt || 0),
        completion: currentState.completion + (newValue.completion || 0),
        total: currentState.total + (newValue.total || 0),
      };
    },
    default: () => ({ prompt: 0, completion: 0, total: 0 }),
  }),
});
