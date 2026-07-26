// 模块说明：负责 platform auto 核心服务与领域逻辑。
import type {
  CommerceDataProviderKind,
  CommerceMarketSourceId,
  CommercePlatformDataRoute,
} from "../types";
import { PlatformBrowserPageProvider } from "./platform-browser-page";
import { PlatformPublicPageProvider } from "./platform-public-page";
import {
  PlatformSerpProvider,
  type PlatformConfig,
} from "./platform-serp";
import type {
  CommerceDataProvider,
  CommerceProviderSearchInput,
  CommerceProviderSearchResult,
} from "./types";

type AutoPlatformSource = Extract<
  CommerceMarketSourceId,
  "tiktok-shop" | "temu" | "1688"
>;

export type PlatformProviderRoute = CommercePlatformDataRoute;

export interface PlatformProviderCandidate {
  route: PlatformProviderRoute;
  label: string;
  provider: CommerceDataProvider;
}

interface PlatformAutoProviderOptions {
  /** 仅用于回归测试或二次开发注入；生产环境按 API → 爬虫创建候选链路。 */
  candidates?: PlatformProviderCandidate[];
}

export interface PlatformRouteDiagnostic {
  route: PlatformProviderRoute;
  label: string;
  configured: boolean;
  success: boolean;
  message: string;
}

const AUTO_PROVIDER_KIND: Record<
  AutoPlatformSource,
  Extract<
    CommerceDataProviderKind,
    "tiktok-shop-auto" | "temu-auto" | "alibaba-1688-auto"
  >
> = {
  "tiktok-shop": "tiktok-shop-auto",
  temu: "temu-auto",
  "1688": "alibaba-1688-auto",
};

/**
 * TikTok Shop / Temu / 1688 的 API 与爬虫全部失败时抛出的结构化错误。
 * Orchestrator 会把 diagnostics 写入来源卡片，让界面明确显示失败发生在哪一条链路。
 */
export class PlatformDataSourceError extends Error {
  readonly sourceId: AutoPlatformSource;
  readonly diagnostics: PlatformRouteDiagnostic[];
  readonly attemptedRoutes: PlatformProviderRoute[];

  constructor(
    sourceId: AutoPlatformSource,
    message: string,
    diagnostics: PlatformRouteDiagnostic[],
  ) {
    super(message);
    this.name = "PlatformDataSourceError";
    this.sourceId = sourceId;
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

function diagnosticMessage(item: PlatformRouteDiagnostic): string {
  if (!item.configured) return `${item.label}：未配置，已跳过`;
  return `${item.label}：${item.success ? "成功" : item.message}`;
}

function routeMessage(
  config: PlatformConfig,
  route: PlatformProviderRoute,
  label: string,
  diagnostics: PlatformRouteDiagnostic[],
): string {
  if (route === "api") {
    return `${config.label} 数据链路：已命中 ${label}，本轮直接使用 API 返回数据进行分析。`;
  }

  const configuredApiFailures = diagnostics.filter(
    (item) => item.route === "api" && item.configured && !item.success,
  );
  if (configuredApiFailures.length) {
    return `${config.label} 数据链路：API 未返回可用数据，已自动降级为 ${label}。`;
  }
  return `${config.label} 数据链路：未检测到可用 API，已自动启用 ${label}。`;
}

/**
 * TikTok Shop / Temu / 1688 自动数据源。
 *
 * 每个平台都遵循完全相同的顺序：
 * 1. 有 TalorData Token 时先请求平台定向 API 数据；
 * 2. API 未配置、请求报错或返回空数组时，先尝试轻量 HTTP 公开页采集；
 * 3. HTTP 页面仅返回 JavaScript 壳、网络失败或解析为空时，继续启动 Playwright；
 * 4. 成功后只返回一条来源的数据，避免不同链路的重复样本污染统计；
 * 5. 所有候选链路都失败时抛出包含完整诊断的 PlatformDataSourceError。
 */
export class PlatformAutoProvider implements CommerceDataProvider {
  readonly kind: CommerceDataProviderKind;
  readonly sourceId: AutoPlatformSource;

  private readonly candidates: PlatformProviderCandidate[];

  constructor(
    private readonly config: PlatformConfig,
    talorDataToken?: string,
    options: PlatformAutoProviderOptions = {},
  ) {
    this.sourceId = config.sourceId;
    this.kind = AUTO_PROVIDER_KIND[config.sourceId];
    this.candidates =
      options.candidates ||
      [
        {
          route: "api",
          label: `TalorData ${config.label} API`,
          provider: new PlatformSerpProvider(config, talorDataToken),
        },
        {
          route: "crawler",
          label: `${config.label} HTTP 公开页爬虫`,
          provider: new PlatformPublicPageProvider(config),
        },
        {
          route: "crawler",
          label: `${config.label} Playwright 浏览器爬虫`,
          provider: new PlatformBrowserPageProvider(config),
        },
      ];
  }

  isConfigured(): boolean {
    return this.candidates.some(({ provider }) => provider.isConfigured());
  }

  async searchProducts(
    input: CommerceProviderSearchInput,
  ): Promise<CommerceProviderSearchResult> {
    const diagnostics: PlatformRouteDiagnostic[] = [];

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
          `[Commerce/${this.config.label}Auto] 开始尝试 ${candidate.label}（${candidate.route}）。`,
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
          `[Commerce/${this.config.label}Auto] ${candidate.label} 成功返回 ${result.products.length} 个样本。`,
        );

        return {
          ...result,
          sourceId: this.config.sourceId,
          warnings: [
            routeMessage(
              this.config,
              candidate.route,
              candidate.label,
              diagnostics,
            ),
            `${this.config.label} 链路诊断：${diagnostics
              .map(diagnosticMessage)
              .join("；")}`,
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
          `[Commerce/${this.config.label}Auto] ${candidate.label} 未提供可用样本：${message}`,
        );
      }
    }

    const configuredApiCount = diagnostics.filter(
      (item) => item.route === "api" && item.configured,
    ).length;
    const summary = configuredApiCount
      ? `${this.config.label} 已配置的 API 与爬虫均未返回可用数据`
      : `${this.config.label} 未配置 API，且公开页面爬虫也未返回可用数据`;
    const detail = diagnostics.map(diagnosticMessage).join("；");
    throw new PlatformDataSourceError(
      this.config.sourceId,
      `${summary}。${detail ? `诊断：${detail}` : ""}`,
      diagnostics,
    );
  }
}

/** 根据成功 Provider 判断最终使用 API 还是爬虫。 */
export function getPlatformRouteFromProvider(
  provider: CommerceDataProviderKind | undefined,
): PlatformProviderRoute | undefined {
  if (
    provider === "talordata-tiktok" ||
    provider === "talordata-temu" ||
    provider === "talordata-1688"
  ) {
    return "api";
  }
  if (
    provider === "tiktok-shop-public-page" ||
    provider === "temu-public-page" ||
    provider === "alibaba-1688-public-page"
  ) {
    return "crawler";
  }
  return undefined;
}
