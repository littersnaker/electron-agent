import { StateGraph, START, END } from "@langchain/langgraph";
import { AgentState } from "./state";
import { MemorySaver } from "@langchain/langgraph";
import { routerNode, executeToolsNode, summarizeHistoryNode } from "./node";

const workflow = new StateGraph(AgentState)
  .addNode("router", routerNode)
  .addNode("execute_tools", executeToolsNode)
  .addNode("summarize", summarizeHistoryNode); // 引入你在上一步补充的 Token 清洗节点

workflow.addEdge(START, "router");

// 动态路由条件
workflow.addConditionalEdges(
  "router",
  (state) => {
    if (state.routeDecision === "TOOL_CALL") {
      return "execute_tools";
    }
    // 如果不需要调用工具了，走动态 Token 摘要压缩，然后结束
    return "summarize";
  },
  {
    execute_tools: "execute_tools",
    summarize: "summarize",
  },
);

// ⚡ 核心闭环：工具执行完后，必须重新回到 router，让大模型检查工具返回的错误或结果！
workflow.addEdge("execute_tools", "router");
workflow.addEdge("summarize", END);

export const graph = workflow.compile({
  checkpointer: new MemorySaver(),
  interruptBefore: ["execute_tools"], // ⚡ 任何工具执行前，图都会自动暂停
});
