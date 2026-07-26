/**
 * 模块职责：MCP JSON-RPC 通信、初始化与工具目录解析。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { DEFAULT_CATALOG_TTL_MS, DEFAULT_TIMEOUT_MS, JsonRpcResponse, MCP_PROTOCOL_VERSION, McpListToolsResult, McpResolvedTool, McpRuntimeSession, McpServerConfig, buildLlmToolName, buildServerRuntimeKey, catalogs, getSession, loadMcpServerConfigs, readPositiveInteger } from "./mcp-configuration";
export function parseSseJson<TResult>(
  body: string,
  expectedId: string | number | undefined,
): JsonRpcResponse<TResult> {
  const dataPayloads = body
    .split(/\r?\n/gu)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");

  for (const payload of dataPayloads.reverse()) {
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse<TResult>;
      if (expectedId === undefined || parsed.id === expectedId) return parsed;
    } catch {
      // SSE 中可能同时包含通知；继续向前寻找匹配 request id 的响应。
    }
  }
  throw new Error("MCP 服务返回了无法解析的 SSE 响应。 ");
}

export async function postJsonRpc<TResult>(
  session: McpRuntimeSession,
  method: string,
  params?: Record<string, unknown>,
  notification = false,
): Promise<TResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    readPositiveInteger("MCP_REQUEST_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
  );
  const requestId = notification ? undefined : session.nextRequestId++;

  try {
    const response = await fetch(session.server.url, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        ...(session.sessionId
          ? { "Mcp-Session-Id": session.sessionId }
          : {}),
        ...(session.server.headers || {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        ...(requestId === undefined ? {} : { id: requestId }),
        method,
        ...(params ? { params } : {}),
      }),
      cache: "no-store",
      signal: controller.signal,
    });

    const returnedSessionId = response.headers.get("mcp-session-id");
    if (returnedSessionId) session.sessionId = returnedSessionId;
    const responseText = await response.text();

    if (!response.ok) {
      throw new Error(
        `MCP ${session.server.id} 请求失败（HTTP ${response.status}）：${responseText.slice(
          0,
          500,
        )}`,
      );
    }
    if (notification || response.status === 202 || !responseText.trim()) {
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    const rpcResponse = contentType.includes("text/event-stream")
      ? parseSseJson<TResult>(responseText, requestId)
      : (JSON.parse(responseText) as JsonRpcResponse<TResult>);

    if (rpcResponse.error) {
      throw new Error(
        `MCP ${session.server.id} 协议错误 ${rpcResponse.error.code ?? ""}: ${
          rpcResponse.error.message || "未知错误"
        }`,
      );
    }
    return rpcResponse.result ?? null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function ensureInitialized(session: McpRuntimeSession): Promise<void> {
  if (session.initialized) return;

  await postJsonRpc(session, "initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: {
      name: "multi-agent-workspace",
      version: "1.0.0",
    },
  });
  await postJsonRpc(session, "notifications/initialized", undefined, true);
  session.initialized = true;
}

export async function listServerTools(
  server: McpServerConfig,
): Promise<McpResolvedTool[]> {
  const session = getSession(server);
  await ensureInitialized(session);

  const resolvedTools: McpResolvedTool[] = [];
  let cursor: string | undefined;
  do {
    const result = await postJsonRpc<McpListToolsResult>(
      session,
      "tools/list",
      cursor ? { cursor } : undefined,
    );
    for (const tool of result?.tools || []) {
      const requiresApproval =
        server.requireApproval?.includes("*") === true ||
        server.requireApproval?.includes(tool.name) === true;
      resolvedTools.push({
        serverId: server.id,
        serverName: server.name || server.id,
        remoteName: tool.name,
        llmName: buildLlmToolName(server.id, tool.name),
        description: [
          `[MCP:${server.name || server.id}]`,
          tool.description || tool.title || `调用远程工具 ${tool.name}。`,
          requiresApproval ? "该工具执行前需要用户确认。" : "",
        ]
          .filter(Boolean)
          .join(" "),
        inputSchema: tool.inputSchema || {
          type: "object",
          properties: {},
          additionalProperties: true,
        },
        requiresApproval,
      });
    }
    cursor = result?.nextCursor;
  } while (cursor);

  return resolvedTools;
}

/** 获取工作区可用 MCP 工具目录，并以 TTL 缓存网络发现结果。 */
export async function resolveMcpTools(
  workingDir: string,
): Promise<McpResolvedTool[]> {
  const servers = loadMcpServerConfigs(workingDir);
  const catalogTtlMs = readPositiveInteger(
    "MCP_CATALOG_TTL_MS",
    DEFAULT_CATALOG_TTL_MS,
  );
  const now = Date.now();
  const allTools: McpResolvedTool[] = [];

  for (const server of servers) {
    const cacheKey = buildServerRuntimeKey(server);
    const cached = catalogs.get(cacheKey);
    if (cached && cached.expiresAtMs > now) {
      allTools.push(...cached.tools);
      continue;
    }

    try {
      const tools = await listServerTools(server);
      catalogs.set(cacheKey, { tools, expiresAtMs: now + catalogTtlMs });
      allTools.push(...tools);
    } catch (error) {
      console.warn(
        `MCP 服务 ${server.id} 工具发现失败:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  const uniqueTools = new Map<string, McpResolvedTool>();
  for (const tool of allTools) {
    if (!uniqueTools.has(tool.llmName)) {
      uniqueTools.set(tool.llmName, tool);
      continue;
    }
    console.warn(`MCP 工具名冲突，已保留第一个定义: ${tool.llmName}`);
  }
  return Array.from(uniqueTools.values());
}
