// 模块说明：负责 config example 核心服务与领域逻辑。
/**
 * 这个文件只导出类型安全的示例，不会在运行时自动连接任何服务器。
 * 将示例内容复制到项目根目录 `.agent-mcp.json` 后，Code Agent 才会发现 MCP 工具。
 */
export const MCP_CONFIGURATION_EXAMPLE = {
  servers: [
    {
      id: "local-tools",
      name: "本地工具服务",
      url: "http://127.0.0.1:8787/mcp",
      enabled: true,
      headers: {
        Authorization: "Bearer ${MCP_LOCAL_TOKEN}",
      },
      requireApproval: ["delete_file", "write_database"],
    },
  ],
} as const;
