import type {
  CommerceAmazonDataRoute,
  CommerceDataProviderKind,
} from "../types";
import { AmazonPublicPageProvider } from "./amazon-public-page";
import { AmazonSpApiProvider } from "./amazon-sp-api";
import { TalorDataMarketProvider } from "./talordata-market";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

/**
 * Amazon 数据链路的内部候选类型。
 *
 * - api：官方 SP-API 或项目现有的 TalorData Amazon API；
 * - crawler：无需 API Key 的 Amazon 公开页面采集器。
 */
export type AmazonProviderRoute = CommerceAmazonDataRoute;

export interface AmazonProviderCandidate {
  route: AmazonProviderRoute;
  label: string;
  provider: CommerceDataProvider;
}

interface AmazonAutoProviderOptions {
  /**
   * 仅用于自动化测试或二次开发注入。生产环境不传时会按
   * “SP-API → TalorData Amazon API → 公开页面爬虫”创建候选链路。
   */
  candidates?: AmazonProviderCandidate[];
}

export interface AmazonRouteDiagnostic {
  route: AmazonProviderRoute;
  label: string;
  configured: boolean;
  success: boolean;
  message: string;
}

/**
 * 所有 Amazon 候选链路均失败时抛出的结构化错误。
 *
 * Orchestrator 可以从中读取已尝试的 API/爬虫链路并传给前端，避免界面只显示
 * “获取失败 · 0 个样本”，却无法判断是 API 未配置、网络失败还是页面解析失败。
 */
export class AmazonDataSourceError extends Error {
  readonly diagnostics: AmazonRouteDiagnostic[];
  readonly attemptedRoutes: AmazonProviderRoute[];

  constructor(message: string, diagnostics: AmazonRouteDiagnostic[]) {
    super(message);
    this.name = "AmazonDataSourceError";
    this.diagnostics = diagnostics;
    this.attemptedRoutes = Array.from(
      new Set(
        diagnostics
          .filter((item) => item.configured)
          .map((item) => item.route),
      ),
    );
  }
}

function hasUsableProducts(result: CommerceProviderSearchResult): boolean {
  return result.products.length > 0;
}

function routeMessage(
  route: AmazonProviderRoute,
  label: string,
  fallbackDiagnostics: AmazonRouteDiagnostic[],
): string {
  if (route === "api") {
    return `Amazon 数据链路：已命中 ${label}，本轮直接使用 API 返回的数据进行分析。`;
  }

  const apiFailures = fallbackDiagnostics.filter(
    (item) => item.route === "api" && item.configured && !item.success,
  );
  if (apiFailures.length) {
    return `Amazon 数据链路：API 未返回可用数据，已自动降级为 ${label}，本轮使用公开页面爬虫数据进行分析。`;
  }

  return `Amazon 数据链路：未检测到可用 API，已自动启用 ${label}，本轮使用公开页面爬虫数据进行分析。`;
}

function diagnosticMessage(item: AmazonRouteDiagnostic): string {
  if (!item.configured) return `${item.label}：未配置，已跳过`;
  return `${item.label}：${item.success ? "成功" : item.message}`;
}

/**
 * Amazon 自动数据源。
 *
 * 该 Provider 只负责“选择正确的数据链路”，不会混合多个 Amazon 来源：
 * 1. 如果配置了 Amazon SP-API，优先请求官方 API；
 * 2. 否则如果配置了 TalorData，则使用项目原有的 Amazon API 数据；
 * 3. 两类 API 都未配置，或已配置但本轮请求失败/返回空数据时，自动切换到公开页面爬虫；
 * 4. 只有所有候选链路都失败时才抛出 `AmazonDataSourceError`。
 *
 * 这样能够保证“有 API 用 API、没有 API 用爬虫”，同时让后续分析层始终接收统一的
 * `CommerceProductSignal[]`，无需为两条链路编写两套分析代码。
 */
export class AmazonAutoProvider implements CommerceDataProvider {
  readonly kind = "amazon-auto" as const;

  private readonly candidates: AmazonProviderCandidate[];

  constructor(
    talorDataToken?: string,
    options: AmazonAutoProviderOptions = {},
  ) {
    this.candidates =
      options.candidates ||
      [
        {
          route: "api",
          label: "Amazon SP-API",
          provider: new AmazonSpApiProvider(),
        },
        {
          route: "api",
          label: "TalorData Amazon API",
          provider: new TalorDataMarketProvider(talorDataToken),
        },
        {
          route: "crawler",
          label: "Amazon 公开页面爬虫",
          provider: new AmazonPublicPageProvider(),
        },
      ];
  }

  isConfigured(): boolean {
    return this.candidates.some(({ provider }) => provider.isConfigured());
  }

  async searchProducts(
    input: CommerceProviderSearchInput,
  ): Promise<CommerceProviderSearchResult> {
    const diagnostics: AmazonRouteDiagnostic[] = [];

    for (const candidate of this.candidates) {
      const configured = candidate.provider.isConfigured();
      if (!configured) {
        diagnostics.push({
          route: candidate.route,
          label: candidate.label,
          configured: false,
          success: false,
          message: "未配置，已跳过。",
        });
        continue;
      }

      try {
        console.info(
          `[Commerce/AmazonAuto] 开始尝试 ${candidate.label}（${candidate.route}）。`,
        );
        const result = await candidate.provider.searchProducts(input);
        if (!hasUsableProducts(result)) {
          throw new Error("数据源请求成功，但没有返回可分析的商品样本。");
        }

        diagnostics.push({
          route: candidate.route,
          label: candidate.label,
          configured: true,
          success: true,
          message: `成功返回 ${result.products.length} 个样本。`,
        });
        console.info(
          `[Commerce/AmazonAuto] ${candidate.label} 成功返回 ${result.products.length} 个样本。`,
        );

        return {
          ...result,
          sourceId: "amazon",
          coverage:
            result.coverage ||
            (candidate.route === "crawler"
              ? ["商品", "价格", "评分", "评论", "公开购买提示", "部分详情字段"]
              : ["商品", "类目", "图片", "排名及 API 可返回字段"]),
          warnings: [
            routeMessage(candidate.route, candidate.label, diagnostics),
            `Amazon 链路诊断：${diagnostics.map(diagnosticMessage).join("；")}`,
            ...result.warnings,
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        diagnostics.push({
          route: candidate.route,
          label: candidate.label,
          configured: true,
          success: false,
          message,
        });
        console.warn(
          `[Commerce/AmazonAuto] ${candidate.label} 未提供可用样本：${message}`,
        );
      }
    }

    const configuredApiCount = diagnostics.filter(
      (item) => item.route === "api" && item.configured,
    ).length;
    const apiDescription = configuredApiCount
      ? "已配置的 Amazon API 与爬虫均未返回可用数据"
      : "未配置 Amazon API，且公开页面爬虫也未返回可用数据";
    const detail = diagnostics.map(diagnosticMessage).join("；");
    throw new AmazonDataSourceError(
      `${apiDescription}。${detail ? `诊断：${detail}` : ""}`,
      diagnostics,
    );
  }
}

/** 供展示层判断 Amazon 成功来源是 API 还是爬虫，不需要比较业务文案。 */
export function getAmazonRouteFromProvider(
  provider: CommerceDataProviderKind | undefined,
): AmazonProviderRoute | undefined {
  if (
    provider === "amazon-sp-api" ||
    provider === "talordata-amazon" ||
    provider === "serpapi-amazon"
  ) {
    return "api";
  }
  return provider === "amazon-public-page" ? "crawler" : undefined;
}
