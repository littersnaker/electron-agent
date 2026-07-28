/** Amazon Listing Demo SSE 接口主流程。 */
import { NextResponse } from "next/server";
import { sendSse, sendSseComment, sendUsage } from "@/app/api/chat/server/sse";
import { buildAmazonListingDemo } from "@/app/lib/commerce/listing/orchestrator";
import type { AmazonListingDemoRequest } from "@/app/lib/commerce/listing/types";
import { resolveLlmCredentials } from "@/app/lib/llm/credentials";
import { AUTO_MODEL_ID } from "@/app/lib/llm/model-catalog";
import { readCommerceCredentialsFromHeaders } from "@/app/lib/service-credentials";
import {
  listingProgress,
  parseListingRequest,
  renderListingText,
} from "./listing-route-helpers";

export async function POST(request: Request): Promise<Response> {
  let body: AmazonListingDemoRequest;
  try {
    body = parseListingRequest(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "请求格式无效" },
      { status: 400 },
    );
  }

  const credentials = resolveLlmCredentials(request.headers);
  const preferredModelId =
    request.headers.get("x-llm-model-id")?.trim() || AUTO_MODEL_ID;
  const serviceCredentials = readCommerceCredentialsFromHeaders(request.headers);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      sendSseComment(controller, encoder, "amazon-listing-demo-connected");
      try {
        listingProgress(controller, encoder, "intent", 8, "正在理解商品 Brief 和 Listing 目标…");
        const result = await buildAmazonListingDemo({
          request: body,
          credentials,
          serviceCredentials,
          preferredModelId,
          signal: request.signal,
          onProgress: (stage, progress, detail) =>
            listingProgress(controller, encoder, stage, progress, detail),
        });

        sendSse(controller, encoder, {
          type: "COMMERCE_LISTING",
          payload: result.report,
        });
        sendSse(controller, encoder, {
          type: "TEXT",
          content: renderListingText(result.report),
        });
        listingProgress(controller, encoder, "done", 100, "Amazon Listing Demo 已生成，可编辑并复制 JSON。");
        sendUsage(controller, encoder, result.usage);
        controller.close();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Amazon Listing Demo 生成失败";
        console.error("Amazon Listing Demo 运行异常:", error);
        sendSse(controller, encoder, {
          type: "AGENT_ERROR",
          agent: {
            id: "commerce",
            name: "Amazon Listing Builder",
            type: "commerce",
            status: "error",
            progress: 100,
            currentTask: message,
          },
        });
        sendSse(controller, encoder, {
          type: "TEXT",
          content: `⚠️ Amazon Listing Demo 暂时无法完成。\n\n${message}`,
        });
        sendUsage(controller, encoder, { prompt: 0, completion: 0, total: 0 });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    },
  });
}
