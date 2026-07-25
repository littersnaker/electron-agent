import { AmazonPublicPageProvider } from "../app/lib/commerce/providers/amazon-public-page";
import type { CommerceProviderSearchInput } from "../app/lib/commerce/providers/types";

/**
 * Amazon 公开页面爬虫网络冒烟测试。
 *
 * 该脚本会执行真实网络请求，不依赖 LLM，也不会进入 Demo 数据。它适合在部署机器上确认：
 * 1. 当前网络或代理能否访问 Amazon；
 * 2. 搜索页是否能被解析为商品卡片；
 * 3. 公开页字段能否归一化为 CommerceProductSignal。
 */
async function main(): Promise<void> {
  const input: CommerceProviderSearchInput = {
    marketplace: "US",
    category: {
      categoryName: "空气炸锅配件",
      categoryNameEn: "Air Fryer Accessories",
      keywords: ["air fryer accessories"],
      subcategories: [],
      analysisDimensions: ["价格", "评分", "评论"],
      researchGoal: "验证 Amazon 公开页面爬虫网络和解析链路。",
    },
    sampleSize: 5,
  };

  const provider = new AmazonPublicPageProvider();
  if (!provider.isConfigured()) {
    throw new Error(
      "Amazon 公开页面爬虫已被禁用。请把 AMAZON_PUBLIC_RESEARCH_ENABLED 设置为 true。",
    );
  }

  const result = await provider.searchProducts(input);
  console.log(`Amazon crawler smoke test passed: ${result.products.length} products.`);
  for (const product of result.products) {
    console.log(
      JSON.stringify(
        {
          asin: product.asin,
          title: product.title,
          price: product.price,
          currency: product.currency,
          rating: product.rating,
          reviewCount: product.reviewCount,
        },
        null,
        2,
      ),
    );
  }
}

void main();
