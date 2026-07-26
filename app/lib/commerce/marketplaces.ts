// 模块说明：负责 marketplaces 核心服务与领域逻辑。
import type { CommerceMarketplaceCode } from "./types";

export interface CommerceMarketplaceDefinition {
  code: CommerceMarketplaceCode;
  label: string;
  marketplaceId: string;
  domain: string;
  locale: string;
  currency: string;
  spApiEndpoint: string;
}

/**
 * 跨境目标市场定义。
 *
 * locale / currency 是核心公开 SERP 本地化参数；Amazon Marketplace ID 与 SP-API endpoint
 * 仅为未来可选的 Amazon 增强 Provider 保留，不再是主流程依赖。
 */
export const COMMERCE_MARKETPLACES: readonly CommerceMarketplaceDefinition[] = [
  {
    code: "US",
    label: "美国站",
    marketplaceId: "ATVPDKIKX0DER",
    domain: "www.amazon.com",
    locale: "en_US",
    currency: "USD",
    spApiEndpoint: "https://sellingpartnerapi-na.amazon.com",
  },
  {
    code: "CA",
    label: "加拿大站",
    marketplaceId: "A2EUQ1WTGCTBG2",
    domain: "www.amazon.ca",
    locale: "en_CA",
    currency: "CAD",
    spApiEndpoint: "https://sellingpartnerapi-na.amazon.com",
  },
  {
    code: "UK",
    label: "英国站",
    marketplaceId: "A1F83G8C2ARO7P",
    domain: "www.amazon.co.uk",
    locale: "en_GB",
    currency: "GBP",
    spApiEndpoint: "https://sellingpartnerapi-eu.amazon.com",
  },
  {
    code: "DE",
    label: "德国站",
    marketplaceId: "A1PA6795UKMFR9",
    domain: "www.amazon.de",
    locale: "de_DE",
    currency: "EUR",
    spApiEndpoint: "https://sellingpartnerapi-eu.amazon.com",
  },
  {
    code: "FR",
    label: "法国站",
    marketplaceId: "A13V1IB3VIYZZH",
    domain: "www.amazon.fr",
    locale: "fr_FR",
    currency: "EUR",
    spApiEndpoint: "https://sellingpartnerapi-eu.amazon.com",
  },
  {
    code: "IT",
    label: "意大利站",
    marketplaceId: "APJ6JRA9NG5V4",
    domain: "www.amazon.it",
    locale: "it_IT",
    currency: "EUR",
    spApiEndpoint: "https://sellingpartnerapi-eu.amazon.com",
  },
  {
    code: "ES",
    label: "西班牙站",
    marketplaceId: "A1RKKUPIHCS9HS",
    domain: "www.amazon.es",
    locale: "es_ES",
    currency: "EUR",
    spApiEndpoint: "https://sellingpartnerapi-eu.amazon.com",
  },
  {
    code: "JP",
    label: "日本站",
    marketplaceId: "A1VC38T7YXB528",
    domain: "www.amazon.co.jp",
    locale: "ja_JP",
    currency: "JPY",
    spApiEndpoint: "https://sellingpartnerapi-fe.amazon.com",
  },
] as const;

export function getCommerceMarketplace(
  code: CommerceMarketplaceCode,
): CommerceMarketplaceDefinition {
  const marketplace = COMMERCE_MARKETPLACES.find((item) => item.code === code);
  if (!marketplace) {
    throw new Error(`暂不支持目标市场 ${code}`);
  }
  return marketplace;
}
