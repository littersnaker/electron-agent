/**
 * 模拟 ERP 适配器。
 *
 * 当前项目尚未接入真实 ERP，因此该模块只负责把用户输入和类目信息整理成一个
 * 可供 Demo 使用的商品档案。任何不是用户明确提供的字段都必须标记为待确认。
 */
import type { CommerceCategoryResolution, CommerceMarketplaceCode } from "../types";
import type { AmazonListingFact, AmazonMockErpProduct } from "./types";

function compactSkuPart(value: string): string {
  return value
    .toLocaleUpperCase()
    .replace(/[^A-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 18) || "PRODUCT";
}

function matchValue(query: string, labels: string[]): string | undefined {
  const joined = labels.join("|");
  const pattern = new RegExp(`(?:${joined})\\s*[:：=]\\s*([^,，;；\\n]{1,80})`, "iu");
  return pattern.exec(query)?.[1]?.trim();
}

function fact(
  id: string,
  label: string,
  value: string,
  source: AmazonListingFact["source"],
  requiresConfirmation: boolean,
): AmazonListingFact {
  return {
    id,
    label,
    value,
    source,
    confidence: source === "user" ? 1 : 0.45,
    requiresConfirmation,
  };
}

export function createMockErpProduct(input: {
  query: string;
  category: CommerceCategoryResolution;
  marketplace: CommerceMarketplaceCode;
}): AmazonMockErpProduct {
  const brand = matchValue(input.query, ["brand", "品牌"]) || "DemoBrand";
  const productName =
    matchValue(input.query, ["product", "product name", "商品名", "产品名"]) ||
    input.category.categoryNameEn;
  const material = matchValue(input.query, ["material", "材质", "面料"]);
  const color = matchValue(input.query, ["color", "colour", "颜色"]);
  const size = matchValue(input.query, ["size", "dimensions", "尺寸", "规格"]);
  const packageContents = matchValue(input.query, ["includes", "package", "包装清单", "包含"]);
  const userBrand = brand !== "DemoBrand";
  const facts: AmazonListingFact[] = [
    fact("brand", "Brand", brand, userBrand ? "user" : "mock-erp", !userBrand),
    fact("product-name", "Product name", productName, "mock-erp", true),
    fact("product-type", "Product type", input.category.categoryNameEn, "mock-erp", true),
  ];

  if (material) facts.push(fact("material", "Material", material, "user", false));
  if (color) facts.push(fact("color", "Color", color, "user", false));
  if (size) facts.push(fact("size", "Size", size, "user", false));
  if (packageContents) {
    facts.push(fact("package", "Package contents", packageContents, "user", false));
  }

  // 为了让 Demo 在极少数据下仍可运行，补充三个明显标记的占位字段。
  if (!material) facts.push(fact("material", "Material", "ERP value required", "mock-erp", true));
  if (!color) facts.push(fact("color", "Color", "ERP value required", "mock-erp", true));
  if (!packageContents) {
    facts.push(fact("package", "Package contents", "ERP value required", "mock-erp", true));
  }

  return {
    sourceName: "Mock ERP Adapter",
    sku: `DEMO-${input.marketplace}-${compactSkuPart(productName)}`,
    brand,
    productName,
    productType: input.category.categoryNameEn,
    facts,
    assumptions: [
      "当前没有连接真实 ERP；未由用户明确提供的字段均为 Demo 占位值。",
      "Amazon 竞品数据只用于关键词和表达方式参考，不会自动变成本商品事实。",
      "正式发布前必须补齐尺寸、材质、包装清单、合规声明和变体属性。",
    ],
    readyForPublish: false,
  };
}
