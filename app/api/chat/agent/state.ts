import { BaseMessage } from "@langchain/core/messages";
import { Annotation, messagesStateReducer } from "@langchain/langgraph";

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer, // 👈 必须用这个，才能正确处理 RemoveMessage 和 ID 查重
    default: () => [],
  }),
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
});
