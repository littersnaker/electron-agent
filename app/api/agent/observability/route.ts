// 模块说明：负责 route 接口及服务端流程。
import { NextResponse } from "next/server";
import { getContextCacheStats } from "@/app/lib/agent-runtime/context-cache";
import {
  getAgentTraceEvents,
  getLatestEvaluation,
  listRecentAgentTraces,
} from "@/app/lib/agent-runtime/trace-store";

export const runtime = "nodejs";

/**
 * Agent 可观测性只读接口。
 *
 * 安全约束：
 * - 不返回 Prompt、源码正文或密钥；Trace 层已经统一执行脱敏与截断；
 * - traceId 只用于读取本机 Trace 数据，不参与文件路径拼接；
 * - limit 会被限制在 1～100，防止一次请求读取过多记录。
 *
 * 查询方式：
 * - 传入 traceId：返回该次运行的事件时间线与最新评估；
 * - 未传 traceId：返回最近运行列表和 Context Cache 命中统计。
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url);
    const traceId = url.searchParams.get("traceId")?.trim() || "";
    const parsedLimit = Number.parseInt(url.searchParams.get("limit") || "30", 10);
    const normalizedLimit = Number.isFinite(parsedLimit) ? parsedLimit : 30;
    const limit = Math.min(Math.max(normalizedLimit, 1), 100);

    if (traceId) {
      return NextResponse.json({
        traceId,
        events: getAgentTraceEvents(traceId),
        evaluation: getLatestEvaluation(traceId),
        contextCache: getContextCacheStats(),
      });
    }

    return NextResponse.json({
      traces: listRecentAgentTraces(limit),
      contextCache: getContextCacheStats(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知错误";

    return NextResponse.json(
      {
        error: "读取 Agent 可观测性数据失败。",
        detail: message,
      },
      { status: 500 },
    );
  }
}
