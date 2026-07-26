/**
 * 模块职责：跨境市场研究接口主处理流程。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import { NextResponse } from "next/server";
import { buildDemoInsights, buildDeterministicInsights, calculateMarketIntelligenceMetrics, calculateSourceConfidence, enrichProductsWithEstimates, inferDataQuality } from "@/app/lib/commerce/analytics";
import { generateCommerceInsights, resolveCommerceCategory } from "@/app/lib/commerce/llm";
import { getCommerceMarketplace } from "@/app/lib/commerce/marketplaces";
import { collectMultiSourceMarketData } from "@/app/lib/commerce/orchestrator/data-source-orchestrator";
import { getCommerceRunModeMeta } from "@/app/lib/commerce/run-mode";
import type { CommerceResearchReport, CommerceResearchRequest } from "@/app/lib/commerce/types";
import { resolveLlmCredentials } from "@/app/lib/llm/credentials";
import { AUTO_MODEL_ID } from "@/app/lib/llm/model-catalog";
import { readCommerceCredentialsFromHeaders } from "@/app/lib/service-credentials";
import { sendSse, sendSseComment, sendUsage } from "@/app/api/chat/server/sse";
import { parseRequest, platformRouteSummary, progress, renderReportText, sourceDisplayLabel } from "./research-route-helpers";
/**
 * 独立的 Cross-border Market Intelligence 研究入口。
 *
 * 三档运行模式由数据源 Orchestrator 自动判断：
 * - full：公开市场 + 至少一个真实增强来源；
 * - market-intelligence：至少有一组真实数据，但增强覆盖不足；
 * - demo：各平台 API、公开页爬虫与其他真实来源都不可用时，使用明确标记的模拟数据走完整流程。
 */
export async function POST(request: Request): Promise<Response> {
  const credentials = resolveLlmCredentials(request.headers);
  const preferredModelId =
    request.headers.get("x-llm-model-id")?.trim() || AUTO_MODEL_ID;

  let body: CommerceResearchRequest;
  try {
    body = parseRequest(await request.json());
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "请求格式无效" },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      sendSseComment(controller, encoder, "commerce-connected");
      let promptTokens = 0;
      let completionTokens = 0;
      let totalTokens = 0;

      try {
        progress(controller, encoder, {
          stage: "intent",
          progress: 8,
          detail: "正在理解你的市场研究目标和研究范围…",
        });

        const categoryResult = await resolveCommerceCategory({
          query: body.query,
          marketplace: body.marketplace,
          recentContext: body.messages,
          credentials,
          preferredModelId,
          signal: request.signal,
        });
        promptTokens += categoryResult.usage.prompt;
        completionTokens += categoryResult.usage.completion;
        totalTokens += categoryResult.usage.total;

        progress(controller, encoder, {
          stage: "category",
          progress: 24,
          detail: `已定位研究方向：${categoryResult.value.categoryName}，正在生成跨境公开市场检索词…`,
        });

        progress(controller, encoder, {
          stage: "collect",
          progress: 38,
          detail:
            "正在并行采集公开市场信号；Amazon、TikTok Shop、Temu 与 1688 均优先使用 API，API 不可用时自动切换公开页面爬虫…",
        });
        const sourceResult = await collectMultiSourceMarketData({
          marketplace: body.marketplace,
          category: categoryResult.value,
          sampleSize: body.sampleSize || 24,
          serviceCredentials: readCommerceCredentialsFromHeaders(
            request.headers,
          ),
          signal: request.signal,
        });

        // Orchestrator 理论上总会返回真实数据或 Demo 数据。这里保留最终防线，避免未来改动
        // 意外生成 sampleSize=0 的空报告。
        if (!sourceResult.products.length && !sourceResult.observations.length) {
          throw new Error("数据源编排未返回真实或演示样本，无法生成报告。");
        }

        const modeMeta = getCommerceRunModeMeta(sourceResult.runMode);
        const routeDetail = platformRouteSummary(sourceResult.sources);

        progress(controller, encoder, {
          stage: "normalize",
          progress: 58,
          detail:
            sourceResult.runMode === "demo"
              ? `真实来源暂无可用数据，已进入${modeMeta.label}，正在生成明确标记的模拟样本…`
              : `${routeDetail}；共取得 ${sourceResult.observations.length} 条公开市场结果和 ${sourceResult.products.length} 个可结构化商品样本，正在统一口径…`,
        });

        // 演示数据只用于验证界面与报告流程，不运行月销量等启发式估算，
        // 从数据对象层面避免模拟字段被后续功能误当作真实需求信号。
        const products =
          sourceResult.runMode === "demo"
            ? sourceResult.products
            : enrichProductsWithEstimates(sourceResult.products);
        const observations = sourceResult.observations;
        const metrics = calculateMarketIntelligenceMetrics(
          products,
          observations,
        );

        progress(controller, encoder, {
          stage: "analyze",
          progress: 72,
          detail:
            sourceResult.runMode === "demo"
              ? "正在计算演示用流程指标；这些评分不会被解释为真实市场结论…"
              : "正在计算市场活跃度、竞争可见度、价格信号与继续研究价值…",
        });

        let insights =
          sourceResult.runMode === "demo"
            ? buildDemoInsights(categoryResult.value.categoryName)
            : buildDeterministicInsights(metrics);
        const warnings = [...sourceResult.warnings];

        // Demo 模式不调用 LLM 做策略判断，防止模型把模拟字段误写成真实商业事实。
        if (sourceResult.runMode !== "demo") {
          try {
            progress(controller, encoder, {
              stage: "strategy",
              progress: 86,
              detail:
                "市场数据分析已完成，正在生成情报摘要、风险与下一步验证建议…",
            });
            const insightResult = await generateCommerceInsights({
              query: body.query,
              marketplace: body.marketplace,
              category: categoryResult.value,
              metrics,
              products,
              observations,
              sources: sourceResult.sources,
              runMode: sourceResult.runMode,
              credentials,
              preferredModelId,
              signal: request.signal,
            });
            insights = insightResult.value;
            promptTokens += insightResult.usage.prompt;
            completionTokens += insightResult.usage.completion;
            totalTokens += insightResult.usage.total;
          } catch (error) {
            warnings.push(
              `运营策略 LLM 生成失败，已使用确定性规则生成基础结论：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        } else {
          progress(controller, encoder, {
            stage: "strategy",
            progress: 86,
            detail:
              "演示模式不会生成真实商业判断，正在整理接入数据源后的升级建议…",
          });
        }

        const marketplace = getCommerceMarketplace(body.marketplace);
        const primaryProvider = sourceResult.sources.find(
          (source) =>
            source.status === "collected" || source.status === "partial",
        )?.provider;
        const quality =
          sourceResult.runMode === "demo"
            ? "unavailable"
            : products.length && primaryProvider
              ? inferDataQuality(products, primaryProvider)
              : observations.length >= 12
                ? "medium"
                : "low";
        const confidenceScore = calculateSourceConfidence(
          sourceResult.sources,
        );
        const realSources = sourceResult.sources.filter(
          (source) =>
            source.sampleSize > 0 && source.status !== "demo",
        );

        const report: CommerceResearchReport = {
          version: 3,
          runMode: sourceResult.runMode,
          generatedAt: new Date().toISOString(),
          query: body.query,
          marketplace: body.marketplace,
          marketplaceLabel: marketplace.label,
          category: categoryResult.value,
          products,
          observations,
          metrics,
          insights,
          dataSource: {
            provider:
              sourceResult.runMode === "demo"
                ? "demo-market"
                : realSources.length > 1
                  ? "multi-source"
                  : primaryProvider || "none",
            quality,
            description:
              sourceResult.runMode === "demo"
                ? "本轮没有取得真实外部市场数据，已使用明确标记的模拟样本展示完整产品流程。模拟内容不会被当作市场事实，也不能用于商业决策。"
                : `${modeMeta.description} 本轮实际使用：${
                    realSources.map(sourceDisplayLabel).join("、") ||
                    "无可用真实来源"
                  }。未获取的平台 API 或爬虫不会阻断报告，也不会参与事实性结论。`,
          },
          sources: sourceResult.sources,
          confidenceScore,
          warnings: Array.from(new Set(warnings)),
        };

        sendSse(controller, encoder, {
          type: "COMMERCE_REPORT",
          payload: report,
        });
        sendSse(controller, encoder, {
          type: "TEXT",
          content: renderReportText(report),
        });
        progress(controller, encoder, {
          stage: "done",
          progress: 100,
          detail:
            sourceResult.runMode === "demo"
              ? "无真实数据演示报告已生成；接入真实数据源后会自动切换为市场洞察或完整研究模式。"
              : `${modeMeta.label}已完成；${routeDetail}，结构化报告可直接导出 PDF。`,
        });
        sendUsage(controller, encoder, {
          prompt: promptTokens,
          completion: completionTokens,
          total: totalTokens,
        });
        controller.close();
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : "Cross-border Market Intelligence Agent 执行失败";
        console.error("Commerce Agent 运行异常:", error);
        sendSse(controller, encoder, {
          type: "AGENT_ERROR",
          agent: {
            id: "commerce",
            name: "Market Intelligence Analyst",
            type: "commerce",
            status: "error",
            progress: 100,
            currentTask: message,
          },
        });
        sendSse(controller, encoder, {
          type: "TEXT",
          content: [
            "⚠️ 跨境市场情报研究暂时无法完成。",
            "",
            message,
            "",
            "系统已支持 Amazon、TikTok Shop、Temu 与 1688 的 API → 公开页面爬虫双链路；单个平台失败不会阻断其他来源。",
            "",
            "可在右上角「服务与数据源」检查 TalorData；没有平台 API 时无需额外填写密钥，系统会自动尝试对应公开页面爬虫。",
          ].join("\n"),
        });
        sendUsage(controller, encoder, {
          prompt: promptTokens,
          completion: completionTokens,
          total: totalTokens,
        });
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
