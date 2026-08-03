// 模块说明：负责 service credentials 核心服务与领域逻辑。
/**
 * Commerce / market-data credentials that are not LLM provider keys.
 *
 * Design notes:
 * - Values are kept in the renderer's localStorage only when the user explicitly enters them.
 * - Server-side environment variables remain the default credentials for packaged Electron builds.
 * - `serpApi` is retained as a read-only compatibility alias for upgrades from v5-v7. New code
 *   should use `talorDataToken`, because TalorData and SerpApi are different providers.
 */
export interface AuxiliaryServiceCredentials {
  /** TalorData SERP API token. */
  talorDataToken?: string;
  /** Legacy alias used by old installations; do not use for new writes. */
  serpApi?: string;

  /** Keepa Data Access API key. */
  keepaApiKey?: string;

  /** Amazon Selling Partner API 凭据（可选；未配置时回退公开页爬虫）。 */
  amazonClientId?: string;
  amazonClientSecret?: string;
  amazonRefreshToken?: string;

  /** TikTok developer / TikTok Shop partner credentials. */
  tiktokClientKey?: string;
  tiktokClientSecret?: string;
  tiktokMerchantId?: string;

  /** Temu Open Platform credentials. */
  temuAppKey?: string;
  temuAppSecret?: string;
  temuAccessToken?: string;

  /** Alibaba / 1688 Open Platform credentials. */
  alibaba1688AppKey?: string;
  alibaba1688AppSecret?: string;
  alibaba1688AccessToken?: string;
}

/**
 * Stable localStorage keys. Keep these provider-specific so credentials never overwrite each other.
 */
export const COMMERCE_STORAGE_KEYS = {
  talorDataToken: "TALORDATA_API_TOKEN",
  legacySerpApi: "SERPAPI_API_KEY",
  keepaApiKey: "KEEPA_API_KEY",
  amazonClientId: "AMAZON_SP_API_CLIENT_ID",
  amazonClientSecret: "AMAZON_SP_API_CLIENT_SECRET",
  amazonRefreshToken: "AMAZON_SP_API_REFRESH_TOKEN",
  tiktokClientKey: "TIKTOK_CLIENT_KEY",
  tiktokClientSecret: "TIKTOK_CLIENT_SECRET",
  tiktokMerchantId: "TIKTOK_MERCHANT_ID",
  temuAppKey: "TEMU_APP_KEY",
  temuAppSecret: "TEMU_APP_SECRET",
  temuAccessToken: "TEMU_ACCESS_TOKEN",
  alibaba1688AppKey: "ALIBABA_1688_APP_KEY",
  alibaba1688AppSecret: "ALIBABA_1688_APP_SECRET",
  alibaba1688AccessToken: "ALIBABA_1688_ACCESS_TOKEN",
} as const;

/** Legacy exports kept so old imports continue compiling during the upgrade. */
export const SERPAPI_STORAGE_KEY = COMMERCE_STORAGE_KEYS.legacySerpApi;

/**
 * Request headers used only between the local Electron renderer and the local FastAPI server.
 * The server still prefers environment variables where a packaged default exists.
 */
export const COMMERCE_REQUEST_HEADERS = {
  talorDataToken: "x-commerce-talordata-token",
  keepaApiKey: "x-commerce-keepa-key",
  amazonClientId: "x-commerce-amazon-client-id",
  amazonClientSecret: "x-commerce-amazon-client-secret",
  amazonRefreshToken: "x-commerce-amazon-refresh-token",
  tiktokClientKey: "x-commerce-tiktok-client-key",
  tiktokClientSecret: "x-commerce-tiktok-client-secret",
  tiktokMerchantId: "x-commerce-tiktok-merchant-id",
  temuAppKey: "x-commerce-temu-app-key",
  temuAppSecret: "x-commerce-temu-app-secret",
  temuAccessToken: "x-commerce-temu-access-token",
  alibaba1688AppKey: "x-commerce-1688-app-key",
  alibaba1688AppSecret: "x-commerce-1688-app-secret",
  alibaba1688AccessToken: "x-commerce-1688-access-token",
} as const;

/** Legacy header alias. */
export const SERPAPI_REQUEST_HEADER = COMMERCE_REQUEST_HEADERS.talorDataToken;

function cleaned(value?: string): string | undefined {
  const result = value?.trim();
  return result || undefined;
}

/**
 * Build renderer -> local-server headers for Commerce requests and provider health checks.
 * Empty values are intentionally omitted so the server can fall back to packaged environment keys.
 */
export function buildCommerceCredentialHeaders(
  credentials: AuxiliaryServiceCredentials,
): Record<string, string> {
  const headers: Record<string, string> = {};
  const talorDataToken = cleaned(
    credentials.talorDataToken || credentials.serpApi,
  );

  const entries: Array<[string, string | undefined]> = [
    [COMMERCE_REQUEST_HEADERS.talorDataToken, talorDataToken],
    [COMMERCE_REQUEST_HEADERS.keepaApiKey, cleaned(credentials.keepaApiKey)],
    [COMMERCE_REQUEST_HEADERS.amazonClientId, cleaned(credentials.amazonClientId)],
    [
      COMMERCE_REQUEST_HEADERS.amazonClientSecret,
      cleaned(credentials.amazonClientSecret),
    ],
    [
      COMMERCE_REQUEST_HEADERS.amazonRefreshToken,
      cleaned(credentials.amazonRefreshToken),
    ],
    [COMMERCE_REQUEST_HEADERS.tiktokClientKey, cleaned(credentials.tiktokClientKey)],
    [COMMERCE_REQUEST_HEADERS.tiktokClientSecret, cleaned(credentials.tiktokClientSecret)],
    [COMMERCE_REQUEST_HEADERS.tiktokMerchantId, cleaned(credentials.tiktokMerchantId)],
    [COMMERCE_REQUEST_HEADERS.temuAppKey, cleaned(credentials.temuAppKey)],
    [COMMERCE_REQUEST_HEADERS.temuAppSecret, cleaned(credentials.temuAppSecret)],
    [COMMERCE_REQUEST_HEADERS.temuAccessToken, cleaned(credentials.temuAccessToken)],
    [COMMERCE_REQUEST_HEADERS.alibaba1688AppKey, cleaned(credentials.alibaba1688AppKey)],
    [COMMERCE_REQUEST_HEADERS.alibaba1688AppSecret, cleaned(credentials.alibaba1688AppSecret)],
    [COMMERCE_REQUEST_HEADERS.alibaba1688AccessToken, cleaned(credentials.alibaba1688AccessToken)],
  ];

  for (const [name, value] of entries) {
    if (value) headers[name] = value;
  }
  return headers;
}

/**
 * Read request-scoped Commerce credentials on the server. Environment fallbacks are resolved by
 * each provider client, so this helper never exposes packaged secrets back to the browser.
 */
export function readCommerceCredentialsFromHeaders(
  headers: Headers,
): AuxiliaryServiceCredentials {
  return {
    talorDataToken: cleaned(headers.get(COMMERCE_REQUEST_HEADERS.talorDataToken) || undefined),
    keepaApiKey: cleaned(headers.get(COMMERCE_REQUEST_HEADERS.keepaApiKey) || undefined),
    amazonClientId: cleaned(
      headers.get(COMMERCE_REQUEST_HEADERS.amazonClientId) || undefined,
    ),
    amazonClientSecret: cleaned(
      headers.get(COMMERCE_REQUEST_HEADERS.amazonClientSecret) || undefined,
    ),
    amazonRefreshToken: cleaned(
      headers.get(COMMERCE_REQUEST_HEADERS.amazonRefreshToken) || undefined,
    ),
    tiktokClientKey: cleaned(headers.get(COMMERCE_REQUEST_HEADERS.tiktokClientKey) || undefined),
    tiktokClientSecret: cleaned(headers.get(COMMERCE_REQUEST_HEADERS.tiktokClientSecret) || undefined),
    tiktokMerchantId: cleaned(headers.get(COMMERCE_REQUEST_HEADERS.tiktokMerchantId) || undefined),
    temuAppKey: cleaned(headers.get(COMMERCE_REQUEST_HEADERS.temuAppKey) || undefined),
    temuAppSecret: cleaned(headers.get(COMMERCE_REQUEST_HEADERS.temuAppSecret) || undefined),
    temuAccessToken: cleaned(headers.get(COMMERCE_REQUEST_HEADERS.temuAccessToken) || undefined),
    alibaba1688AppKey: cleaned(headers.get(COMMERCE_REQUEST_HEADERS.alibaba1688AppKey) || undefined),
    alibaba1688AppSecret: cleaned(headers.get(COMMERCE_REQUEST_HEADERS.alibaba1688AppSecret) || undefined),
    alibaba1688AccessToken: cleaned(headers.get(COMMERCE_REQUEST_HEADERS.alibaba1688AccessToken) || undefined),
  };
}
