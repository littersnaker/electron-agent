// 模块说明：负责 route 接口及服务端流程。
import { NextResponse } from "next/server";
import {
  loadMcpServerConfigs,
  resolveMcpTools,
} from "@/app/lib/mcp/client";
import { resolveChatWorkspace } from "@/app/api/chat/server/resolve-chat-workspace";

export const runtime = "nodejs";

/**
 * 查看当前项目可用的 MCP Server 与工具目录。
 *
 * 工作目录必须通过项目数据库解析，禁止客户端传入任意本地路径；返回结果也不会
 * 暴露 Authorization 等请求头，只展示服务标识、地址、工具名和审批策略。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const projectId = url.searchParams.get("projectId");
    const workspace = resolveChatWorkspace(projectId, undefined);
    const servers = loadMcpServerConfigs(workspace.workingDir).map((server) => ({
      id: server.id,
      name: server.name,
      url: server.url,
      enabled: server.enabled !== false,
      requireApproval: server.requireApproval || [],
    }));
    const tools = await resolveMcpTools(workspace.workingDir);

    return NextResponse.json({
      projectId: workspace.projectId,
      projectName: workspace.projectName,
      servers,
      tools: tools.map((tool) => ({
        serverId: tool.serverId,
        serverName: tool.serverName,
        name: tool.llmName,
        remoteName: tool.remoteName,
        description: tool.description,
        requiresApproval: tool.requiresApproval,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "读取 MCP 状态失败";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
