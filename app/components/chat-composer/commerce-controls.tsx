"use client";

import { COMMERCE_MARKETPLACES } from "../../lib/commerce/marketplaces";
import type { CommerceMarketplaceCode } from "../../lib/commerce/types";
import type { CommerceWorkflowMode } from "../../lib/commerce/listing/types";

export function CommerceControls({
  workflowMode,
  onWorkflowModeChange,
  marketplaceCode,
  onMarketplaceChange,
  dataSourceState,
  onOpenServiceSettings,
  disabled,
}: {
  workflowMode: CommerceWorkflowMode;
  onWorkflowModeChange?: (mode: CommerceWorkflowMode) => void;
  marketplaceCode: CommerceMarketplaceCode;
  onMarketplaceChange?: (marketplace: CommerceMarketplaceCode) => void;
  dataSourceState: "environment" | "local" | "none";
  onOpenServiceSettings?: () => void;
  disabled: boolean;
}) {
  return (
    <div
      className="mb-2 rounded-[15px] border px-3 py-2.5"
      style={{
        background:
          "linear-gradient(145deg, var(--accent-blue-soft), var(--glass-soft))",
        borderColor: "var(--accent-blue-border)",
      }}
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold text-[var(--text-secondary)]">
            Commerce 工作流
          </div>
          <div className="mt-0.5 text-[8px] text-[var(--text-quaternary)]">
            市场研究与 Listing Demo 共用 Amazon 数据链路
          </div>
        </div>
        <div className="flex rounded-[10px] border border-[var(--border)] bg-[var(--glass)] p-1">
          {([
            ["research", "市场研究"],
            ["listing", "Listing Demo"],
          ] as const).map(([value, label]) => {
            const selected = workflowMode === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => onWorkflowModeChange?.(value)}
                disabled={disabled}
                className="rounded-[8px] px-2.5 py-1.5 text-[9px] font-semibold transition-colors disabled:opacity-40"
                style={{
                  background: selected
                    ? "var(--selection-bg-strong)"
                    : "transparent",
                  color: selected
                    ? "var(--selection-text)"
                    : "var(--text-tertiary)",
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="mr-1 min-w-[92px]">
          <div className="text-[10px] font-semibold text-[var(--text-secondary)]">
            目标市场
          </div>
          <div className="mt-0.5 text-[8px] text-[var(--text-quaternary)]">
            决定本地化语言与货币
          </div>
        </div>
        <div className="flex flex-1 flex-wrap gap-1.5">
          {COMMERCE_MARKETPLACES.map((marketplace) => {
            const selected = marketplaceCode === marketplace.code;
            return (
              <button
                key={marketplace.code}
                type="button"
                onClick={() => onMarketplaceChange?.(marketplace.code)}
                disabled={disabled}
                className="rounded-full border px-2.5 py-1.5 text-[9px] font-medium transition-all disabled:opacity-40"
                style={{
                  background: selected
                    ? "var(--selection-bg)"
                    : "transparent",
                  borderColor: selected
                    ? "var(--selection-border)"
                    : "var(--border)",
                  color: selected
                    ? "var(--selection-text)"
                    : "var(--text-tertiary)",
                }}
                title={`${marketplace.label} · ${marketplace.currency}`}
              >
                {marketplace.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[8px] leading-4 text-[var(--text-quaternary)]">
        <span>
          {workflowMode === "listing"
            ? "Listing Demo 使用模拟 ERP 商品档案 + Amazon API/爬虫竞品信息，不会自动发布。"
            : "市场研究优先采集公开 SERP，并以 Amazon、Keepa 等来源作为可选增强。"}
        </span>
        <button
          type="button"
          onClick={onOpenServiceSettings}
          className="rounded-full border px-2.5 py-1 text-[8px] font-semibold transition-colors hover:bg-[var(--glass-hover)]"
          style={{
            color:
              dataSourceState !== "none"
                ? "var(--accent-blue)"
                : "var(--text-secondary)",
            borderColor:
              dataSourceState !== "none"
                ? "var(--accent-blue-border-strong)"
                : "var(--border)",
            background:
              dataSourceState !== "none"
                ? "var(--accent-blue-soft)"
                : "var(--glass)",
          }}
          title="设置 TalorData、Keepa 或 Amazon SP-API；未配置时会尝试 Amazon 公开页面爬虫"
        >
          {dataSourceState === "environment"
            ? "默认数据源已就绪"
            : dataSourceState === "local"
              ? "本地数据源已设置"
              : "数据源设置"}
        </button>
      </div>
    </div>
  );
}
