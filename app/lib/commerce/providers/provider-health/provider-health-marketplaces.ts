/**
 * 模块职责：TikTok 与 Temu 数据源健康检查。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { createHash } from "crypto";
import type { AuxiliaryServiceCredentials } from "../../../service-credentials";
import { type CommerceProviderHealthResult, classifyHttpFailure, isRecord, readErrorMessage, requestOrEnv } from "./provider-health-core";
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

export function md5Signature(
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
