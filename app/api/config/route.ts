import { NextResponse } from "next/server";
import { hasProviderCredential } from "@/app/lib/llm/credentials";
import { LLM_MODEL_CATALOG } from "@/app/lib/llm/model-catalog";

export const runtime = "nodejs";

/** 仅返回配置状态和公开模型元数据，永远不返回服务端 API Key。 */
export function GET(): Response {
  return NextResponse.json({
    providers: {
      qwen: { hasDefaultKey: hasProviderCredential("qwen") },
      openai: { hasDefaultKey: hasProviderCredential("openai") },
      gemini: { hasDefaultKey: hasProviderCredential("gemini") },
    },
    models: LLM_MODEL_CATALOG.map((model) => ({
      id: model.id,
      provider: model.provider,
      name: model.name,
      description: model.description,
    })),
  });
}
