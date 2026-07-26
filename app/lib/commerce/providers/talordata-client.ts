// 模块说明：负责 talordata client 核心服务与领域逻辑。
import {
  collectTalorDataResultRows,
  describeTalorDataPayload,
} from "./talordata-response";

/**
 * TalorData SERP 底层请求客户端。
 *
 * 当前 TalorData 账号或文档中可能出现两种兼容路径：
 *   POST https://serpapi.talordata.net/serp/v1/request
 *   POST https://serpapi.talordata.net/request
 *
 * 默认优先使用 `/serp/v1/request`，较短的 `/request` 只作为自动兼容回退。
 * 请求使用 Bearer Token 和 `application/x-www-form-urlencoded`。旧版项目曾误用账户接口，
 * 因此这里会主动忽略已知错误地址；私有部署仍可通过 `TALORDATA_SERP_ENDPOINT` 覆盖。
 */

const CURRENT_ENDPOINT = "https://serpapi.talordata.net/serp/v1/request";
const COMPAT_ENDPOINT = "https://serpapi.talordata.net/request";
const LEGACY_WRONG_ENDPOINT =
  "https://api.talordata.com/accounts/v1/serp/get_serp_data";

export interface TalorDataSearchRequest {
  engine?:
    | "google"
    | "google_shopping"
    | "bing"
    | "yandex"
    | "duckduckgo";
  q: string;
  location?: string;
  num?: number;
  device?: "desktop" | "mobile";
  /** Google 地区、语言和域名提示，用于让结果更贴近目标站点。 */
  gl?: string;
  hl?: string;
  googleDomain?: string;
  /** 兼容旧调用的 Google 垂直搜索参数，例如 `shop`。 */
  tbm?: string;
  /** 结构化 JSON 输出模式；TalorData 快速开始示例使用 1。 */
  json?: 1 | 2;
}

export interface TalorDataRequestResult {
  payload: unknown;
  credentialSource: "request" | "environment";
  endpoint: string;
  latencyMs: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const nestedData = isRecord(payload.data) ? payload.data : undefined;
  const candidates = [
    payload.error,
    payload.message,
    payload.msg,
    nestedData?.error,
    nestedData?.message,
  ];
  return candidates.find(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  )?.trim();
}

/**
 * 用户可能把完整环境变量赋值或 `Bearer ...` 一起粘贴进设置框。
 * 在发起请求前统一清理这些形式，避免界面看似已配置、实际却因多余前缀返回 401。
 */
export function normalizeTalorDataToken(value?: string): string | undefined {
  if (!value) return undefined;
  let token = value.trim();
  token = token.replace(/^(?:SERPAPI_API_KEY|TALORDATA_API_TOKEN)\s*=\s*/iu, "");
  token = token.replace(/^Bearer\s+/iu, "");
  token = token.replace(/^["']|["']$/gu, "").trim();
  return token || undefined;
}

export function getTalorDataEnvironmentToken(): string | undefined {
  return normalizeTalorDataToken(
    process.env.TALORDATA_API_TOKEN || process.env.SERPAPI_API_KEY,
  );
}

export function getTalorDataTokenCandidates(
  requestToken?: string,
): Array<{ source: "request" | "environment"; token: string }> {
  const environment = getTalorDataEnvironmentToken();
  const request = normalizeTalorDataToken(requestToken);
  const candidates: Array<{ source: "request" | "environment"; token: string }> = [];

  // 应用环境变量是默认凭据；设置页 Token 仅作为不同值时的备用候选。
  // 这样旧 localStorage 中的失效 Token 不会覆盖打包环境中的有效 Token。
  if (environment) candidates.push({ source: "environment", token: environment });
  if (request && request !== environment) candidates.push({ source: "request", token: request });
  return candidates;
}

export function describeSecret(value?: string): string {
  const token = normalizeTalorDataToken(value);
  if (!token) return "missing";
  if (token.length <= 8) return `${"*".repeat(token.length)} (len:${token.length})`;
  return `${token.slice(0, 5)}…${token.slice(-4)} (len:${token.length})`;
}

function getEndpointCandidates(): string[] {
  const configured = process.env.TALORDATA_SERP_ENDPOINT?.trim();
  const candidates: string[] = [];

  // v6/v7 曾配置过错误的账户接口；升级后绝不继续请求该地址。
  if (configured && configured !== LEGACY_WRONG_ENDPOINT) candidates.push(configured);
  candidates.push(CURRENT_ENDPOINT, COMPAT_ENDPOINT);
  return Array.from(new Set(candidates));
}

export function getTalorDataPrimaryEndpoint(): string {
  return getEndpointCandidates()[0] || CURRENT_ENDPOINT;
}

async function parsePayload(response: Response): Promise<unknown> {
  const raw = await response.text();
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { message: raw.slice(0, 800) };
  }
}

function shouldTryNextEndpoint(status: number): boolean {
  // 404/405 通常代表接口路径不兼容；旧账户接口也可能返回 401。
  // 这些状态允许继续尝试下一兼容路径，其他业务错误则立即停止，避免重复消耗请求。
  return status === 401 || status === 404 || status === 405;
}

async function executeRequestAtEndpoint(
  endpoint: string,
  token: string,
  input: TalorDataSearchRequest,
  signal?: AbortSignal,
): Promise<{ payload: unknown; latencyMs: number }> {
  const form = new URLSearchParams({
    engine: input.engine || "google",
    q: input.q,
    device: input.device || "desktop",
    location: input.location || "United States",
    num: String(Math.min(100, Math.max(1, input.num || 10))),
    json: String(input.json || 1),
    ...(input.gl ? { gl: input.gl } : {}),
    ...(input.hl ? { hl: input.hl } : {}),
    ...(input.googleDomain ? { google_domain: input.googleDomain } : {}),
    ...(input.tbm ? { tbm: input.tbm } : {}),
  });

  const startedAt = Date.now();
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: form.toString(),
    signal,
  });
  const latencyMs = Date.now() - startedAt;
  const payload = await parsePayload(response);

  if (!response.ok) {
    const providerMessage = readMessage(payload);
    const error = new Error(
      `TalorData SERP 请求失败（HTTP ${response.status}）${
        providerMessage ? `：${providerMessage}` : ""
      }`,
    ) as Error & { status?: number; endpoint?: string };
    error.status = response.status;
    error.endpoint = endpoint;
    throw error;
  }

  const apiError = readMessage(payload);
  if (apiError && /unauthor|invalid\s*(?:token|key)|forbidden/iu.test(apiError)) {
    throw new Error(`TalorData SERP 返回认证错误：${apiError}`);
  }

  return { payload, latencyMs };
}

async function executeRequest(
  token: string,
  input: TalorDataSearchRequest,
  signal?: AbortSignal,
): Promise<{ payload: unknown; endpoint: string; latencyMs: number }> {
  const errors: string[] = [];
  const endpoints = getEndpointCandidates();

  for (const endpoint of endpoints) {
    try {
      const result = await executeRequestAtEndpoint(endpoint, token, input, signal);
      return { ...result, endpoint };
    } catch (error) {
      const typed = error as Error & { status?: number };
      errors.push(`${endpoint}: ${typed.message}`);
      if (typed.status !== undefined && !shouldTryNextEndpoint(typed.status)) break;
    }
  }

  throw new Error(Array.from(new Set(errors)).join("；"));
}

/**
 * 先尝试应用环境 Token，再尝试用户输入且不同的本地 Token。
 * 既保护打包应用中的默认配置，也允许用户不重新构建 Electron 就测试另一个 Token。
 */
export async function requestTalorData(
  input: TalorDataSearchRequest,
  requestToken?: string,
  signal?: AbortSignal,
): Promise<TalorDataRequestResult> {
  const candidates = getTalorDataTokenCandidates(requestToken);
  if (!candidates.length) {
    throw new Error(
      "未检测到 TalorData Token。推荐使用 TALORDATA_API_TOKEN；旧变量 SERPAPI_API_KEY 仍兼容。",
    );
  }

  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      const result = await executeRequest(candidate.token, input, signal);
      return {
        ...result,
        credentialSource: candidate.source,
      };
    } catch (error) {
      errors.push(
        `${candidate.source}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  throw new Error(Array.from(new Set(errors)).join("；"));
}

/**
 * 使用最小真实搜索同时验证接口、Bearer Token 和响应解析。
 *
 * 旧逻辑只要 HTTP 200 就显示“连接成功”，即使返回结构无法被 Commerce Provider 识别，
 * 实际研究仍会报空数据。v10 必须至少解析出一条结果，才能通过健康检查。
 */
export async function testTalorDataConnection(
  requestToken?: string,
  signal?: AbortSignal,
): Promise<{
  source: "request" | "environment";
  endpoint: string;
  latencyMs: number;
  parsedResultCount: number;
}> {
  const result = await requestTalorData(
    {
      q: "amazon",
      engine: "google",
      device: "desktop",
      location: "United States",
      num: 1,
      json: 1,
    },
    requestToken,
    signal,
  );
  const parsedResultCount = collectTalorDataResultRows(result.payload).length;
  if (!parsedResultCount) {
    throw new Error(
      `TalorData 已建立连接，但测试响应中没有解析到搜索结果。响应结构：${describeTalorDataPayload(
        result.payload,
      )}`,
    );
  }

  return {
    source: result.credentialSource,
    endpoint: result.endpoint,
    latencyMs: result.latencyMs,
    parsedResultCount,
  };
}
