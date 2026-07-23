import { NextResponse } from "next/server";
import { hasProviderCredential } from "@/app/lib/llm/credentials";
import { LLM_MODEL_CATALOG } from "@/app/lib/llm/registry/models";
import { LLM_PROVIDER_CATALOG } from "@/app/lib/llm/registry/providers";

export const runtime = "nodejs";

/** 只返回公开配置状态，不返回服务端 API Key。 */
export function GET(): Response {
  return NextResponse.json({
    providers: Object.fromEntries(
      LLM_PROVIDER_CATALOG.map((provider) => [
        provider.id,
        {
          name: provider.name,
          environmentKey: provider.environmentKey,
          hasDefaultKey: hasProviderCredential(provider.id),
        },
      ]),
    ),
    models: LLM_MODEL_CATALOG.map((model) => ({
      id: model.id,
      provider: model.provider,
      name: model.name,
      description: model.description,
      capabilities: model.capabilities,
      chatCompatible: model.chatCompatible !== false,
    })),
  });
}
