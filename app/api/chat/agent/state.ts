import { BaseMessage } from "@langchain/core/messages";
import { Annotation } from "@langchain/langgraph";

export const AgentState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (x, y) => x.concat(y),
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