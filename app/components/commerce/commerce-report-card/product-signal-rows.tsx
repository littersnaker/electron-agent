"use client";
/**
 * 模块职责：市场观察与商品信号行组件。
 * 说明：该文件由原大型模块按单一职责拆分，便于测试、维护与复用。
 */
import type { CommerceMarketObservation, CommerceProductSignal } from "../../../lib/commerce/types";
import { formatCompact, formatPrice } from "./metric-widgets";
export function observationTypeLabel(type: CommerceMarketObservation["resultType"]): string {
  if (type === "shopping") return "Shopping";
  if (type === "organic") return "Web";
  if (type === "ad") return "Ad";
  if (type === "related") return "Related";
  return "Other";
}

export function ObservationRow({ observation }: { observation: CommerceMarketObservation }) {
  return (
    <div className="grid grid-cols-[70px_minmax(0,1fr)_88px] items-center gap-2 border-t border-[var(--border)] px-2 py-2.5 text-[10px] first:border-t-0">
      <span className="font-mono text-[9px] text-[var(--text-tertiary)]">
        {observationTypeLabel(observation.resultType)}
      </span>
      <div className="min-w-0">
        {observation.url ? (
          <a
            href={observation.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate font-medium text-[var(--text-primary)] transition-opacity hover:opacity-70"
            title={observation.title}
          >
            {observation.title}
          </a>
        ) : (
          <div className="truncate font-medium text-[var(--text-primary)]" title={observation.title}>
            {observation.title}
          </div>
        )}
        <div className="mt-0.5 truncate text-[9px] text-[var(--text-tertiary)]">
          {observation.domain || observation.merchant || "公开搜索结果"}
        </div>
      </div>
      <div className="text-right font-mono text-[var(--text-secondary)]">
        {formatPrice(observation.price, observation.currency)}
      </div>
    </div>
  );
}

export function ProductRow({ product }: { product: CommerceProductSignal }) {
  const isAmazon = !product.platform || product.platform === "amazon";
  const demandText = isAmazon
    ? product.recentPurchaseLowerBound
      ? `${formatCompact(product.recentPurchaseLowerBound)}+/mo`
      : product.estimatedMonthlyUnits
        ? `~${formatCompact(product.estimatedMonthlyUnits.median)}`
        : "—"
    : product.recentPurchaseLabel ||
      (product.recentPurchaseLowerBound
        ? `${formatCompact(product.recentPurchaseLowerBound)}+ sold`
        : "—");

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_78px_62px_66px] items-center gap-2 border-t border-[var(--border)] px-2 py-2.5 text-[10px] first:border-t-0">
      <div className="min-w-0">
        {product.productUrl ? (
          <a
            href={product.productUrl}
            target="_blank"
            rel="noreferrer"
            className="block truncate font-medium text-[var(--text-primary)] transition-opacity hover:opacity-70"
            title={product.title}
          >
            {product.title}
          </a>
        ) : (
          <div
            className="truncate font-medium text-[var(--text-primary)]"
            title={product.title}
          >
            {product.title}
          </div>
        )}
        <div className="mt-0.5 flex items-center gap-2 text-[9px] text-[var(--text-tertiary)]">
          <span className="font-mono">{product.platform === "amazon" || !product.platform ? product.asin : product.platform}</span>
          {product.brand && <span className="truncate">{product.brand}</span>}
        </div>
      </div>
      <div className="text-right font-mono text-[var(--text-secondary)]">
        {formatPrice(product.price, product.currency)}
      </div>
      <div className="text-right font-mono text-[var(--text-secondary)]">
        {product.salesRank ? `#${formatCompact(product.salesRank)}` : "—"}
      </div>
      <div className="text-right font-mono text-[var(--text-secondary)]">
        {demandText}
      </div>
    </div>
  );
}
