/**
 * 模块职责：MCP 工具调用、内容格式化与缓存清理。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { type McpCallToolResult, type McpResolvedTool, type McpToolCallOutcome, catalogs, getSession, loadMcpServerConfigs } from "./mcp-configuration";
import { ensureInitialized, postJsonRpc } from "./mcp-protocol";
export function formatMcpContent(result: McpCallToolResult): string {
  const textItems = (result.content || []).flatMap((item) => {
    if (item.type === "text" && typeof item.text === "string") {
      return [item.text];
    }
    if (item.type === "resource_link" && typeof item.uri === "string") {
      return [`资源链接: ${item.uri}`];
    }
    return [JSON.stringify(item)];
  });

  if (result.structuredContent !== undefined) {
    textItems.push(
      `结构化结果:\n${JSON.stringify(result.structuredContent, null, 2)}`,
    );
  }
  return textItems.join("\n\n") || "MCP 工具没有返回可展示内容。";
}

/** 调用已发现的 MCP 工具；工具级错误会作为 ToolMessage 内容返回给模型自修复。 */
export async function callMcpTool(
  workingDir: string,
  tool: McpResolvedTool,
  args: Record<string, unknown>,
): Promise<McpToolCallOutcome> {
  const server = loadMcpServerConfigs(workingDir).find(
    (candidate) => candidate.id === tool.serverId,
  );
  if (!server) {
    throw new Error(`MCP 服务 ${tool.serverId} 已从配置中移除。`);
  }

  const session = getSession(server);
  await ensureInitialized(session);
  const result = await postJsonRpc<McpCallToolResult>(session, "tools/call", {
    name: tool.remoteName,
    arguments: args,
  });

  return {
    content: formatMcpContent(result || {}),
    isError: result?.isError === true,
    serverId: tool.serverId,
    remoteName: tool.remoteName,
  };
}

export function clearMcpCatalogCache(): void {
  catalogs.clear();
}
