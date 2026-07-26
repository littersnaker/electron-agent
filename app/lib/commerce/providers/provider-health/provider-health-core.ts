/**
 * 模块职责：健康检查类型、通用错误处理、TalorData 与 Keepa 检查。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { AuxiliaryServiceCredentials } from "../../../service-credentials";
import { describeSecret, getTalorDataEnvironmentToken, testTalorDataConnection } from "../talordata-client";
export type CommerceHealthProviderId =
  | "talordata"
  | "keepa"
  | "tiktok"
  | "temu"
  | "1688";

export type CommerceHealthState =
  | "connected"
  | "partial"
  | "unconfigured"
  | "unauthorized"
  | "quota_exceeded"
  | "network_error"
  | "error";

export interface CommerceProviderHealthResult {
  provider: CommerceHealthProviderId;
  ok: boolean;
  state: CommerceHealthState;
  message: string;
  latencyMs?: number;
  credentialSource?: "request" | "environment" | "mixed";
  credentialFingerprint?: string;
  endpoint?: string;
  /** Extra non-secret notes shown in the settings UI. */
  detail?: string;
}

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function valueText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function readErrorMessage(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const data = isRecord(payload.data) ? payload.data : undefined;
  const errorResponse = isRecord(payload.error_response)
    ? payload.error_response
    : undefined;
  const candidates = [
    payload.error,
    payload.message,
    payload.msg,
    payload.error_msg,
    payload.errorMsg,
    data?.message,
    data?.error,
    errorResponse?.sub_msg,
    errorResponse?.msg,
  ];
  return candidates.find(
    (value): value is string => typeof value === "string" && Boolean(value.trim()),
  )?.trim();
}

export function clean(value?: string): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

export function classifyHttpFailure(
  provider: CommerceHealthProviderId,
  status: number,
  message: string,
  endpoint?: string,
): CommerceProviderHealthResult {
  if (status === 401 || status === 403) {
    return {
      provider,
      ok: false,
      state: "unauthorized",
      message,
      endpoint,
    };
  }
  if (status === 402 || status === 429) {
    return {
      provider,
      ok: false,
      state: "quota_exceeded",
      message,
      endpoint,
    };
  }
  return {
    provider,
    ok: false,
    state: "error",
    message,
    endpoint,
  };
}

export function requestOrEnv(
  requestValue: string | undefined,
  envValue: string | undefined,
): { value?: string; source?: "request" | "environment" } {
  const request = clean(requestValue);
  const environment = clean(envValue);
  if (request) return { value: request, source: "request" };
  if (environment) return { value: environment, source: "environment" };
  return {};
}

/** Test TalorData using an actual 1-result SERP request. */
export async function testTalorDataHealth(
  credentials: AuxiliaryServiceCredentials,
  signal?: AbortSignal,
): Promise<CommerceProviderHealthResult> {
  const requestToken = clean(credentials.talorDataToken || credentials.serpApi);
  try {
    const result = await testTalorDataConnection(requestToken, signal);
    const selectedToken =
      result.source === "environment" ? getTalorDataEnvironmentToken() : requestToken;
    return {
      provider: "talordata",
      ok: true,
      state: "connected",
      message: "TalorData SERP 连接正常。",
      detail: `已完成真实 Google SERP 最小请求，并成功解析 ${result.parsedResultCount} 条搜索结果。`,
      endpoint: result.endpoint,
      latencyMs: result.latencyMs,
      credentialSource: result.source,
      credentialFingerprint: describeSecret(selectedToken),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      provider: "talordata",
      ok: false,
      state: /401|unauthor/iu.test(message) ? "unauthorized" : "error",
      message,
      credentialSource: requestToken ? "request" : "environment",
      credentialFingerprint: describeSecret(
        requestToken || getTalorDataEnvironmentToken(),
      ),
    };
  }
}

/**
 * Keepa exposes a lightweight token-status endpoint. This validates the key without requiring a
 * product ASIN and is therefore ideal for a settings-page health check.
 */
export async function testKeepaHealth(
  credentials: AuxiliaryServiceCredentials,
  signal?: AbortSignal,
): Promise<CommerceProviderHealthResult> {
  const resolved = requestOrEnv(credentials.keepaApiKey, process.env.KEEPA_API_KEY);
  if (!resolved.value) {
    return {
      provider: "keepa",
      ok: false,
      state: "unconfigured",
      message: "未配置 Keepa API Key。",
    };
  }

  const endpoint = `https://api.keepa.com/token?key=${encodeURIComponent(resolved.value)}`;
  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, { signal });
    const latencyMs = Date.now() - startedAt;
    const payload = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) {
      return {
        ...classifyHttpFailure(
          "keepa",
          response.status,
          `Keepa 请求失败（HTTP ${response.status}）${
            readErrorMessage(payload) ? `：${readErrorMessage(payload)}` : ""
          }`,
        ),
        latencyMs,
        credentialSource: resolved.source,
      };
    }

    const tokensLeft = isRecord(payload) ? payload.tokensLeft : undefined;
    return {
      provider: "keepa",
      ok: true,
      state: "connected",
      message: "Keepa 连接正常。",
      detail:
        typeof tokensLeft === "number"
          ? `当前可用 tokens：${tokensLeft}`
          : "已通过 Keepa token status 验证。",
      latencyMs,
      credentialSource: resolved.source,
    };
  } catch (error) {
    return {
      provider: "keepa",
      ok: false,
      state: "network_error",
      message: error instanceof Error ? error.message : "Keepa 网络请求失败。",
      credentialSource: resolved.source,
    };
  }
}
