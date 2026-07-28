/**
 * 模块职责：1688 健康检查、统一调度与环境状态汇总。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { AuxiliaryServiceCredentials } from "../../../service-credentials";
import { describeSecret, getTalorDataEnvironmentToken } from "../talordata-client";
import { type CommerceHealthProviderId, type CommerceProviderHealthResult, classifyHttpFailure, clean, isRecord, readErrorMessage, requestOrEnv, testKeepaHealth, testTalorDataHealth } from "./provider-health-core";
import { md5Signature, testTemuHealth, testTikTokHealth } from "./provider-health-marketplaces";
export function formatGmt8Timestamp(date = new Date()): string {
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
