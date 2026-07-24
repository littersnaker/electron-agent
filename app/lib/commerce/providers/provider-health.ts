import { createHash } from "crypto";
import type { AuxiliaryServiceCredentials } from "../../service-credentials";
import {
  describeSecret,
  getTalorDataEnvironmentToken,
  testTalorDataConnection,
} from "./talordata-client";

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

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function valueText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readErrorMessage(payload: unknown): string | undefined {
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

function clean(value?: string): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

function classifyHttpFailure(
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

function requestOrEnv(
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

/**
 * Validate TikTok developer credentials.
 *
 * If a Merchant ID is supplied we use TikTok's merchant OAuth endpoint; otherwise we validate
 * client_key/client_secret with the client-credentials endpoint. The latter proves the developer
 * credentials but does not imply that TikTok Shop seller scopes are authorized, so the result is
 * intentionally marked `partial`.
 */
export async function testTikTokHealth(
  credentials: AuxiliaryServiceCredentials,
  signal?: AbortSignal,
): Promise<CommerceProviderHealthResult> {
  const clientKey = requestOrEnv(
    credentials.tiktokClientKey,
    process.env.TIKTOK_CLIENT_KEY,
  );
  const clientSecret = requestOrEnv(
    credentials.tiktokClientSecret,
    process.env.TIKTOK_CLIENT_SECRET,
  );
  const merchantId = requestOrEnv(
    credentials.tiktokMerchantId,
    process.env.TIKTOK_MERCHANT_ID,
  );
  if (!clientKey.value || !clientSecret.value) {
    return {
      provider: "tiktok",
      ok: false,
      state: "unconfigured",
      message: "TikTok 至少需要 Client Key 与 Client Secret。",
    };
  }

  const merchantMode = Boolean(merchantId.value);
  const endpoint = merchantMode
    ? "https://open.tiktokapis.com/merchant/oauth/token/"
    : "https://open.tiktokapis.com/v2/oauth/token/";
  const form = new URLSearchParams({
    client_key: clientKey.value,
    client_secret: clientSecret.value,
    grant_type: merchantMode ? "access_token" : "client_credentials",
    ...(merchantId.value ? { merchant_id: merchantId.value } : {}),
  });

  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...(merchantMode ? { "x-tt-target-idc": "alisg" } : {}),
      },
      body: form.toString(),
      signal,
    });
    const latencyMs = Date.now() - startedAt;
    const payload = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok || readErrorMessage(payload)) {
      const providerMessage = readErrorMessage(payload);
      return {
        ...classifyHttpFailure(
          "tiktok",
          response.status || 400,
          `TikTok API 验证失败${providerMessage ? `：${providerMessage}` : ""}`,
          endpoint,
        ),
        latencyMs,
        credentialSource: "mixed",
      };
    }

    return {
      provider: "tiktok",
      ok: true,
      state: merchantMode ? "connected" : "partial",
      message: merchantMode
        ? "TikTok Shop 商家凭证连接正常。"
        : "TikTok 开发者凭证有效。",
      detail: merchantMode
        ? "Merchant OAuth 已通过。具体 Shop 数据仍受应用 scope 和商家授权范围限制。"
        : "尚未填写 Merchant ID，因此只验证开发者 Client 凭证；市场研究仍使用公开数据源。",
      endpoint,
      latencyMs,
      credentialSource: "mixed",
    };
  } catch (error) {
    return {
      provider: "tiktok",
      ok: false,
      state: "network_error",
      message: error instanceof Error ? error.message : "TikTok API 网络请求失败。",
      endpoint,
      credentialSource: "mixed",
    };
  }
}

function md5Signature(
  params: Record<string, string>,
  secret: string,
): string {
  const joined = Object.entries(params)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}${value}`)
    .join("");
  return createHash("md5")
    .update(`${secret}${joined}${secret}`, "utf8")
    .digest("hex")
    .toUpperCase();
}

/**
 * Validate Temu Open Platform credentials with `bg.open.accesstoken.info.get`.
 * The request uses Temu's MD5 signature convention (secret + sorted key/value pairs + secret).
 */
export async function testTemuHealth(
  credentials: AuxiliaryServiceCredentials,
  signal?: AbortSignal,
): Promise<CommerceProviderHealthResult> {
  const appKey = requestOrEnv(credentials.temuAppKey, process.env.TEMU_APP_KEY);
  const appSecret = requestOrEnv(
    credentials.temuAppSecret,
    process.env.TEMU_APP_SECRET,
  );
  const accessToken = requestOrEnv(
    credentials.temuAccessToken,
    process.env.TEMU_ACCESS_TOKEN,
  );
  if (!appKey.value || !appSecret.value || !accessToken.value) {
    return {
      provider: "temu",
      ok: false,
      state: "unconfigured",
      message: "Temu 需要 App Key、App Secret 与 Access Token。",
    };
  }

  const endpoint =
    process.env.TEMU_API_ENDPOINT?.trim() ||
    "https://openapi-b-us.temu.com/openapi/router";
  const params: Record<string, string> = {
    type: "bg.open.accesstoken.info.get",
    app_key: appKey.value,
    timestamp: String(Math.floor(Date.now() / 1000)),
    data_type: "JSON",
    access_token: accessToken.value,
  };
  const payload = { ...params, sign: md5Signature(params, appSecret.value) };

  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal,
    });
    const latencyMs = Date.now() - startedAt;
    const body = (await response.json().catch(() => undefined)) as unknown;
    const providerMessage = readErrorMessage(body);
    const bodyFailed =
      isRecord(body) &&
      (body.success === false || body.result === false || Boolean(body.error_code));
    if (!response.ok || bodyFailed || providerMessage) {
      return {
        ...classifyHttpFailure(
          "temu",
          response.status || 400,
          `Temu Open API 验证失败${providerMessage ? `：${providerMessage}` : ""}`,
          endpoint,
        ),
        latencyMs,
        credentialSource: "mixed",
      };
    }

    return {
      provider: "temu",
      ok: true,
      state: "connected",
      message: "Temu Open API 连接正常。",
      detail: "Access Token 信息接口已通过；具体数据范围取决于已申请的 API 权限。",
      endpoint,
      latencyMs,
      credentialSource: "mixed",
    };
  } catch (error) {
    return {
      provider: "temu",
      ok: false,
      state: "network_error",
      message: error instanceof Error ? error.message : "Temu API 网络请求失败。",
      endpoint,
      credentialSource: "mixed",
    };
  }
}

function formatGmt8Timestamp(date = new Date()): string {
  const shifted = new Date(date.getTime() + 8 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(
    shifted.getUTCDate(),
  )} ${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(
    shifted.getUTCSeconds(),
  )}`;
}

/**
 * Validate Alibaba / 1688 Open Platform credentials using TOP's signed router request.
 * - With an Access Token we call `alibaba.open.accountid.get` to validate the 1688 authorization.
 * - Without an Access Token we call `taobao.time.get`; this only validates App Key/Secret and is
 *   therefore returned as `partial` rather than pretending seller/buyer authorization exists.
 */
export async function testAlibaba1688Health(
  credentials: AuxiliaryServiceCredentials,
  signal?: AbortSignal,
): Promise<CommerceProviderHealthResult> {
  const appKey = requestOrEnv(
    credentials.alibaba1688AppKey,
    process.env.ALIBABA_1688_APP_KEY,
  );
  const appSecret = requestOrEnv(
    credentials.alibaba1688AppSecret,
    process.env.ALIBABA_1688_APP_SECRET,
  );
  const accessToken = requestOrEnv(
    credentials.alibaba1688AccessToken,
    process.env.ALIBABA_1688_ACCESS_TOKEN,
  );
  if (!appKey.value || !appSecret.value) {
    return {
      provider: "1688",
      ok: false,
      state: "unconfigured",
      message: "1688 至少需要 App Key 与 App Secret。",
    };
  }

  const endpoint =
    process.env.ALIBABA_1688_API_ENDPOINT?.trim() ||
    "https://eco.taobao.com/router/rest";
  const method = accessToken.value
    ? "alibaba.open.accountid.get"
    : "taobao.time.get";
  const params: Record<string, string> = {
    method,
    app_key: appKey.value,
    timestamp: formatGmt8Timestamp(),
    format: "json",
    v: "2.0",
    sign_method: "md5",
    ...(accessToken.value ? { session: accessToken.value } : {}),
  };
  const form = new URLSearchParams({
    ...params,
    sign: md5Signature(params, appSecret.value),
  });

  const startedAt = Date.now();
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      },
      body: form.toString(),
      signal,
    });
    const latencyMs = Date.now() - startedAt;
    const body = (await response.json().catch(() => undefined)) as unknown;
    const providerMessage = readErrorMessage(body);
    if (!response.ok || (isRecord(body) && isRecord(body.error_response))) {
      return {
        ...classifyHttpFailure(
          "1688",
          response.status || 400,
          `1688 Open API 验证失败${providerMessage ? `：${providerMessage}` : ""}`,
          endpoint,
        ),
        latencyMs,
        credentialSource: "mixed",
      };
    }

    return {
      provider: "1688",
      ok: true,
      state: accessToken.value ? "connected" : "partial",
      message: accessToken.value
        ? "1688 Open API 授权连接正常。"
        : "1688 App Key / Secret 验证通过。",
      detail: accessToken.value
        ? "已调用 1688 授权账号接口；后续数据仍受具体 API 权限限制。"
        : "未填写 Access Token，因此只验证了应用凭证；授权业务数据尚未验证。",
      endpoint,
      latencyMs,
      credentialSource: "mixed",
    };
  } catch (error) {
    return {
      provider: "1688",
      ok: false,
      state: "network_error",
      message: error instanceof Error ? error.message : "1688 API 网络请求失败。",
      endpoint,
      credentialSource: "mixed",
    };
  }
}

export async function testCommerceProviderHealth(
  provider: CommerceHealthProviderId,
  credentials: AuxiliaryServiceCredentials,
  signal?: AbortSignal,
): Promise<CommerceProviderHealthResult> {
  switch (provider) {
    case "talordata":
      return testTalorDataHealth(credentials, signal);
    case "keepa":
      return testKeepaHealth(credentials, signal);
    case "tiktok":
      return testTikTokHealth(credentials, signal);
    case "temu":
      return testTemuHealth(credentials, signal);
    case "1688":
      return testAlibaba1688Health(credentials, signal);
    default: {
      const exhaustive: never = provider;
      return {
        provider: exhaustive,
        ok: false,
        state: "error",
        message: "未知数据源。",
      };
    }
  }
}

export function environmentProviderSummary(): Record<
  CommerceHealthProviderId,
  { configured: boolean; fingerprint?: string }
> {
  const talorData = getTalorDataEnvironmentToken();
  return {
    talordata: {
      configured: Boolean(talorData),
      fingerprint: talorData ? describeSecret(talorData) : undefined,
    },
    keepa: { configured: Boolean(clean(process.env.KEEPA_API_KEY)) },
    tiktok: {
      configured: Boolean(
        clean(process.env.TIKTOK_CLIENT_KEY) && clean(process.env.TIKTOK_CLIENT_SECRET),
      ),
    },
    temu: {
      configured: Boolean(
        clean(process.env.TEMU_APP_KEY) &&
          clean(process.env.TEMU_APP_SECRET) &&
          clean(process.env.TEMU_ACCESS_TOKEN),
      ),
    },
    "1688": {
      configured: Boolean(
        clean(process.env.ALIBABA_1688_APP_KEY) &&
          clean(process.env.ALIBABA_1688_APP_SECRET),
      ),
    },
  };
}
