import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "./state";
import { MemorySaver } from "@langchain/langgraph";
import {
  routerNode,
  executeToolsNode,
  summarizeHistoryNode,
  reportNode,
} from "./node";

const workflow = new StateGraph(AgentState)
  .addNode("router", routerNode)
  .addNode("execute_tools", executeToolsNode)
  .addNode("summarize", summarizeHistoryNode)
  .addNode("report", reportNode)
  .addEdge("report", END);

workflow.addEdge(START, "router");

// 动态路由条件
workflow.addConditionalEdges(
  "router",
  (state) => {
    if (state.routeDecision === "TOOL_CALL") {
      return "execute_tools";
    }

    return "summarize";
  },
  {
    execute_tools: "execute_tools",
    summarize: "summarize",
  },
);

// ⚡ 核心闭环：工具执行完后，必须重新回到 router，让大模型检查工具返回的错误或结果！
workflow.addEdge("execute_tools", "router");
workflow.addEdge("summarize", "report");
workflow.addEdge("report", END);

export const graph = workflow.compile({
  // ⚠️ 注意：MemorySaver 是内存存储器，服务器重启后对话历史会丢失。
  // 生产环境建议改用 SqliteSaver 或 RedisSaver 等持久化方案。
  checkpointer: new MemorySaver(),
  // interruptBefore: ["execute_tools"], // ⚡ 任何工具执行前，图都会自动暂停
});
