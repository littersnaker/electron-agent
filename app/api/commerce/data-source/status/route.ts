import { NextResponse } from "next/server";
import {
  environmentProviderSummary,
  testCommerceProviderHealth,
  type CommerceHealthProviderId,
} from "@/app/lib/commerce/providers/provider-health";
import { getTalorDataPrimaryEndpoint } from "@/app/lib/commerce/providers/talordata-client";
import { readCommerceCredentialsFromHeaders } from "@/app/lib/service-credentials";

export const runtime = "nodejs";

const PROVIDER_IDS = new Set<CommerceHealthProviderId>([
  "talordata",
  "keepa",
  "tiktok",
  "temu",
  "1688",
]);

/**
 * Metadata-only status endpoint. It never returns secrets and never consumes provider quota.
 * The legacy `environmentConfigured` field is retained for older UI code and means TalorData.
 */
export async function GET(): Promise<Response> {
  const providers = environmentProviderSummary();
  return NextResponse.json({
    environmentConfigured: providers.talordata.configured,
    environmentTokenFingerprint: providers.talordata.fingerprint,
    keepaConfigured: providers.keepa.configured,
    endpoint: getTalorDataPrimaryEndpoint(),
    providers,
  });
}

/**
 * Run a real, provider-specific health check only after the user presses “验证”.
 * Unsaved UI credentials travel in local renderer -> local Next headers, while missing fields fall
 * back to packaged environment variables inside the provider health implementation.
 */
export async function POST(request: Request): Promise<Response> {
  let body: { provider?: unknown } = {};
  try {
    body = (await request.json()) as { provider?: unknown };
  } catch {
    // Keep the explicit validation error below rather than exposing a JSON parser message.
  }

  const provider =
    typeof body.provider === "string"
      ? (body.provider as CommerceHealthProviderId)
      : undefined;
  if (!provider || !PROVIDER_IDS.has(provider)) {
    return NextResponse.json(
      { ok: false, state: "error", message: "请选择需要验证的数据源。" },
      { status: 400 },
    );
  }

  const credentials = readCommerceCredentialsFromHeaders(request.headers);
  const result = await testCommerceProviderHealth(
    provider,
    credentials,
    request.signal,
  );

  // Keep HTTP 200 for provider-level failures so the settings UI can render the structured state
  // without treating expected 401/quota results as a transport exception.
  return NextResponse.json(result);
}
