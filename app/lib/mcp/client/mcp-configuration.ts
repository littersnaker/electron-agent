/**
 * 模块职责：MCP 配置读取、服务校验与会话管理。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
export const MCP_PROTOCOL_VERSION = "2025-11-25";

export const DEFAULT_TIMEOUT_MS = 15_000;

export const DEFAULT_CATALOG_TTL_MS = 60_000;

export const MCP_TOOL_PREFIX = "mcp__";

export interface McpServerConfig {
  id: string;
  name?: string;
  url: string;
  enabled?: boolean;
  headers?: Record<string, string>;
  /** 需要人工确认的 MCP 工具名；支持 "*" 表示该服务器全部工具。 */
  requireApproval?: string[];
}

export interface McpConfigurationFile {
  servers?: McpServerConfig[];
}

export interface McpToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpListToolsResult {
  tools?: McpToolDefinition[];
  nextCursor?: string;
}

export interface McpCallToolResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface JsonRpcResponse<TResult> {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: TResult;
  error?: {
    code?: number;
    message?: string;
    data?: unknown;
  };
}

export interface McpRuntimeSession {
  server: McpServerConfig;
  sessionId: string | null;
  initialized: boolean;
  nextRequestId: number;
}

export interface McpCatalogEntry {
  expiresAtMs: number;
  tools: McpResolvedTool[];
}

export interface McpResolvedTool {
  serverId: string;
  serverName: string;
  remoteName: string;
  llmName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresApproval: boolean;
}

export interface McpToolCallOutcome {
  content: string;
  isError: boolean;
  serverId: string;
  remoteName: string;
}

export const sessions = new Map<string, McpRuntimeSession>();

export const catalogs = new Map<string, McpCatalogEntry>();

export function readPositiveInteger(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function interpolateEnvironment(value: string): string {
  return value.replace(/\$\{([A-Z0-9_]+)\}/gu, (_match, name: string) => {
    return process.env[name] || "";
  });
}

export function sanitizeIdentifier(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
}

export function buildLlmToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeIdentifier(serverId)}__${sanitizeIdentifier(
    toolName,
  )}`.slice(0, 120);
}

export function validateServerUrl(rawUrl: string): string {
  const url = new URL(interpolateEnvironment(rawUrl));
  if (url.username || url.password) {
    throw new Error("MCP URL 不允许内嵌用户名或密码，请改用 headers 配置。 ");
  }

  const isLocalHttp =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !isLocalHttp) {
    throw new Error(
      `MCP 服务 ${url.toString()} 必须使用 HTTPS；本地 localhost 可使用 HTTP。`,
    );
  }
  return url.toString();
}

export function normalizeServerConfig(config: McpServerConfig): McpServerConfig {
  const id = sanitizeIdentifier(config.id);
  if (!id) throw new Error("MCP server.id 不能为空。 ");

  return {
    id,
    name: config.name?.trim() || id,
    url: validateServerUrl(config.url),
    enabled: config.enabled !== false,
    headers: Object.fromEntries(
      Object.entries(config.headers || {})
        .map(([key, value]) => [key.trim(), interpolateEnvironment(value)])
        .filter(([key, value]) => Boolean(key && value)),
    ),
    requireApproval: Array.from(
      new Set((config.requireApproval || []).map((item) => item.trim())),
    ).filter(Boolean),
  };
}

export function readConfigurationFile(filePath: string): McpServerConfig[] {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as
    | McpConfigurationFile
    | McpServerConfig[];
  const servers = Array.isArray(parsed) ? parsed : parsed.servers || [];
  return servers.map(normalizeServerConfig).filter((server) => server.enabled);
}

/**
 * MCP 配置读取顺序：
 * 1. 环境变量 MCP_SERVERS_JSON，适合部署环境注入；
 * 2. 工作区根目录 `.agent-mcp.json`，适合项目级工具配置。
 *
 * 两处配置按 server.id 去重，环境变量优先。模型无法动态修改服务器地址。
 */
export function loadMcpServerConfigs(workingDir: string): McpServerConfig[] {
  const configured: McpServerConfig[] = [];
  const rawEnvironmentConfig = process.env.MCP_SERVERS_JSON?.trim();

  if (rawEnvironmentConfig) {
    try {
      const parsed = JSON.parse(rawEnvironmentConfig) as
        | McpConfigurationFile
        | McpServerConfig[];
      const servers = Array.isArray(parsed) ? parsed : parsed.servers || [];
      configured.push(
        ...servers
          .map(normalizeServerConfig)
          .filter((server) => server.enabled),
      );
    } catch (error) {
      console.warn(
        "MCP_SERVERS_JSON 解析失败，已忽略环境变量配置:",
        error instanceof Error ? error.message : error,
      );
    }
  }

  const workspaceConfigPath = path.join(
    path.resolve(workingDir || process.cwd()),
    ".agent-mcp.json",
  );
  try {
    configured.push(...readConfigurationFile(workspaceConfigPath));
  } catch (error) {
    console.warn(
      `.agent-mcp.json 解析失败，已忽略项目配置: ${workspaceConfigPath}`,
      error instanceof Error ? error.message : error,
    );
  }

  const unique = new Map<string, McpServerConfig>();
  for (const server of configured) {
    if (!unique.has(server.id)) unique.set(server.id, server);
  }
  return Array.from(unique.values());
}

export function buildServerRuntimeKey(server: McpServerConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: server.id,
        url: server.url,
        headers: server.headers || {},
      }),
    )
    .digest("hex");
}

export function getSession(server: McpServerConfig): McpRuntimeSession {
  const runtimeKey = buildServerRuntimeKey(server);
  const existing = sessions.get(runtimeKey);
  if (existing) {
    existing.server = server;
    return existing;
  }

  const created: McpRuntimeSession = {
    server,
    sessionId: null,
    initialized: false,
    nextRequestId: 1,
  };
  sessions.set(runtimeKey, created);
  return created;
}
