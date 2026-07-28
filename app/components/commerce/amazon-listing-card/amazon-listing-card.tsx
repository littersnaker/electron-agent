"use client";

import { useMemo, useState } from "react";
import { validateAmazonListing } from "../../../lib/commerce/listing/compliance";
import type {
  AmazonListingDemoReport,
  AmazonListingDraft,
  AmazonListingIssue,
} from "../../../lib/commerce/listing/types";
import { ListingEditor } from "./listing-editor";
import { ListingMetrics } from "./listing-metrics";

function issueColor(severity: "error" | "warning" | "suggestion"): string {
  if (severity === "error") return "#ff453a";
  if (severity === "warning") return "#ff9f0a";
  return "#64b5ff";
}

async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

export function AmazonListingCard({ report }: { report: AmazonListingDemoReport }) {
  const [draft, setDraft] = useState<AmazonListingDraft>(report.draft);
  const [copied, setCopied] = useState(false);
  const validation = useMemo(
    () =>
      validateAmazonListing({
        draft,
        keywords: report.keywords,
        mockErp: report.mockErp,
        competitorBrands: report.competitors
          .map((product) => product.brand || "")
          .filter(Boolean),
      }),
    [draft, report.competitors, report.keywords, report.mockErp],
  );
  const errors = validation.issues.filter(
    (issue: AmazonListingIssue) => issue.severity === "error",
  );
  const sourceLabel = report.source.isDemo
    ? "模拟竞品"
    : report.source.dataRoute === "crawler"
      ? "Amazon 爬虫"
      : "Amazon API";

  const handleCopy = async () => {
    await copyText(
      JSON.stringify(
        {
          marketplace: report.marketplace,
          sku: report.mockErp.sku,
          draft,
          validation,
          facts: report.mockErp.facts,
        },
        null,
        2,
      ),
    );
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <section className="mb-3 overflow-hidden rounded-[18px] border border-[var(--border)] bg-[var(--glass)]">
      <div className="border-b border-[var(--border)] px-4 py-3.5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-[rgba(10,132,255,0.12)] px-2 py-1 text-[8px] font-semibold text-[#64b5ff]">
                Amazon Listing Demo
              </span>
              <span className="rounded-full bg-[rgba(255,159,10,0.12)] px-2 py-1 text-[8px] font-semibold text-[#ff9f0a]">
                Mock ERP
              </span>
              <span className="text-[8px] text-[var(--text-quaternary)]">
                {report.marketplaceLabel} · {sourceLabel} {report.source.sampleSize} 条
              </span>
            </div>
            <h3 className="mt-2 text-[15px] font-semibold text-[var(--text-primary)]">
              {report.mockErp.productName}
            </h3>
            <p className="mt-1 text-[9px] leading-4 text-[var(--text-tertiary)]">
              SKU {report.mockErp.sku} · 当前仅用于演示生成、编辑和本地校验，不会发布到 Amazon。
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="rounded-[12px] border border-[var(--border)] bg-[var(--glass-soft)] px-3 py-2 text-center">
              <div className="font-mono text-[18px] font-semibold text-[var(--text-primary)]">
                {validation.score.overall}
              </div>
              <div className="text-[8px] text-[var(--text-quaternary)]">Demo Score</div>
            </div>
            <button
              type="button"
              onClick={() => void handleCopy()}
              className="rounded-[11px] border border-[var(--border)] bg-[var(--glass-soft)] px-3 py-2 text-[9px] font-semibold text-[var(--text-secondary)] transition-colors hover:bg-[var(--glass-hover)]"
            >
              {copied ? "JSON 已复制" : "复制 Listing JSON"}
            </button>
          </div>
        </div>
        <div className="mt-3">
          <ListingMetrics score={validation.score} />
        </div>
      </div>

      <div className="grid gap-4 px-4 py-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(260px,0.75fr)]">
        <ListingEditor draft={draft} setDraft={setDraft} validation={validation} />

        <aside className="space-y-3">
          <div className="rounded-[14px] border border-[rgba(255,159,10,0.22)] bg-[rgba(255,159,10,0.07)] p-3 text-[9px] leading-4 text-[var(--text-secondary)]">
            <strong className="text-[#ff9f0a]">不可直接发布：</strong>
            当前商品主数据来自模拟 ERP。尺寸、材质、包装、认证、兼容性和性能声明必须由真实 ERP 或人工确认。
          </div>

          <details open className="rounded-[14px] border border-[var(--border)] bg-[var(--glass-soft)] p-3">
            <summary className="cursor-pointer text-[10px] font-semibold text-[var(--text-secondary)]">
              商品事实 · {report.mockErp.facts.length}
            </summary>
            <div className="mt-2 space-y-1.5">
              {report.mockErp.facts.map((fact) => (
                <div key={fact.id} className="rounded-[9px] border border-[var(--border)] bg-[var(--glass)] px-2.5 py-2">
                  <div className="flex items-center justify-between gap-2 text-[8px] text-[var(--text-quaternary)]">
                    <span>{fact.label}</span>
                    <span style={{ color: fact.requiresConfirmation ? "#ff9f0a" : "#30d158" }}>
                      {fact.requiresConfirmation ? "待确认" : "用户提供"}
                    </span>
                  </div>
                  <div className="mt-1 break-words text-[9px] text-[var(--text-secondary)]">{fact.value}</div>
                </div>
              ))}
            </div>
          </details>

          <details open className="rounded-[14px] border border-[var(--border)] bg-[var(--glass-soft)] p-3">
            <summary className="cursor-pointer text-[10px] font-semibold text-[var(--text-secondary)]">
              关键词计划 · {report.keywords.length}
            </summary>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {report.keywords.map((keyword) => (
                <span
                  key={keyword.normalized}
                  className="rounded-full border border-[var(--border)] bg-[var(--glass)] px-2 py-1 text-[8px] text-[var(--text-tertiary)]"
                  title={`${keyword.source} · ${keyword.cluster} · ${keyword.placement} · ${keyword.score}`}
                >
                  {keyword.phrase}
                </span>
              ))}
            </div>
          </details>

          <details open className="rounded-[14px] border border-[var(--border)] bg-[var(--glass-soft)] p-3">
            <summary className="cursor-pointer text-[10px] font-semibold text-[var(--text-secondary)]">
              校验结果 · {errors.length} 个错误 / {validation.issues.length} 项
            </summary>
            <div className="mt-2 space-y-1.5">
              {validation.issues.length === 0 ? (
                <div className="text-[9px] text-[#30d158]">本地 Demo 规则检查已通过。</div>
              ) : (
                validation.issues.map((issue: AmazonListingIssue, index: number) => (
                  <div key={`${issue.code}-${index}`} className="text-[9px] leading-4 text-[var(--text-secondary)]">
                    <span style={{ color: issueColor(issue.severity) }}>●</span>{" "}
                    {issue.message}
                  </div>
                ))
              )}
            </div>
          </details>

          <details className="rounded-[14px] border border-[var(--border)] bg-[var(--glass-soft)] p-3">
            <summary className="cursor-pointer text-[10px] font-semibold text-[var(--text-secondary)]">
              数据来源与限制
            </summary>
            <div className="mt-2 space-y-1.5 text-[8px] leading-4 text-[var(--text-tertiary)]">
              <p>{report.source.description}</p>
              {report.warnings.slice(0, 8).map((warning) => (
                <p key={warning}>• {warning}</p>
              ))}
            </div>
          </details>
        </aside>
      </div>
    </section>
  );
}
