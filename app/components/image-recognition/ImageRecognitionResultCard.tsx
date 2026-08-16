// 模块说明：图片识别结果卡片（货架矩阵 + 来源 + 失败清单 + Excel 下载）。
"use client";

import { useMemo } from "react";
import type {
  ImageRecognitionFailure,
  ImageRecognitionResult,
  ImageRecognitionRow,
} from "../../constants/page-constants";

const COLORS = {
  text: "var(--text-primary)",
  textMuted: "var(--text-secondary)",
  textSubtle: "var(--text-tertiary)",
  material: "var(--glass)",
  border: "var(--border)",
  blue: "var(--accent-blue)",
  green: "var(--accent-green)",
  amber: "var(--accent-amber)",
  red: "var(--accent-red)",
};

/** 把“第1层”/“第2排”这类中文序号统一成排序可用的数字键。 */
function indexOfChinesePosition(value: string): number {
  const match = /第\s*(\d+)\s*[层排位]/.exec(value || "");
  return match ? Number.parseInt(match[1], 10) : 0;
}

/** 按层号、排号排序识别行，保证展示与 Excel 顺序一致。 */
function sortedRows(rows: ImageRecognitionRow[]): ImageRecognitionRow[] {
  return [...rows].sort(
    (a, b) =>
      indexOfChinesePosition(a.row) - indexOfChinesePosition(b.row) ||
      indexOfChinesePosition(a.col) - indexOfChinesePosition(b.col) ||
      a.sheetNo.localeCompare(b.sheetNo, "zh-CN"),
  );
}

/** 按层分组、层内按排连续编号的列表式渲染（与 Excel“第N层 第M排”一致）。 */
function ShelfGrid({ rows }: { rows: ImageRecognitionRow[] }) {
  const sorted = useMemo(() => sortedRows(rows), [rows]);
  const grouped = useMemo(() => {
    const map = new Map<number, ImageRecognitionRow[]>();
    for (const row of sorted) {
      const layer = indexOfChinesePosition(row.row);
      if (!map.has(layer)) map.set(layer, []);
      map.get(layer)!.push(row);
    }
    return [...map.entries()].sort((a, b) => a[0] - b[0]);
  }, [sorted]);

  return (
    <div className="space-y-2">
      {grouped.map(([layer, layerRows]) => (
        <div
          key={layer}
          className="rounded-[12px] border px-3 py-2"
          style={{ borderColor: COLORS.border, background: "color-mix(in srgb, var(--glass) 45%, transparent)" }}
        >
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em]" style={{ color: COLORS.textSubtle }}>
            第{layer}层
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {layerRows.map((item) => (
              <span
                key={`${item.sheetNo}-${item.col}`}
                className="inline-flex items-center gap-1 rounded-[8px] border px-2 py-1 text-[12px] font-semibold tracking-[-0.01em]"
                style={{
                  color: COLORS.text,
                  background: "color-mix(in srgb, var(--accent-blue-soft-strong) 45%, transparent)",
                  borderColor: "color-mix(in srgb, var(--accent-blue) 32%, transparent)",
                }}
                title={`${item.sheetNo} · ${item.row}${item.col}${item.note ? ` · ${item.note}` : ""} · ${item.sourceImage}`}
              >
                {item.col}
                <span className="text-[13px]" style={{ color: COLORS.blue }}>
                  {item.sheetNo}
                </span>
                {item.note && <span className="text-[9px] font-normal" style={{ color: COLORS.amber }}>{item.note}</span>}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function FailureList({ failures }: { failures: ImageRecognitionFailure[] }) {
  if (failures.length === 0) return null;
  const rateLimited = failures.some((failure) => failure.kind === "rate_limited");
  return (
    <div
      className="mt-3 rounded-[12px] border px-3 py-2.5"
      style={{
        borderColor: rateLimited
          ? "color-mix(in srgb, var(--accent-amber) 45%, var(--border))"
          : "color-mix(in srgb, var(--accent-red) 35%, var(--border))",
      }}
    >
      <div
        className="text-[11px] font-semibold"
        style={{ color: rateLimited ? "var(--accent-amber)" : "var(--accent-red)" }}
      >
        {rateLimited
          ? "⚠️ 部分照片因模型限流未识别（免费模型访问量大，稍后重试即可）"
          : `⚠️ ${failures.length} 张照片识别失败（已跳过，未影响其他照片）`}
      </div>
      <ul className="mt-1.5 space-y-1">
        {failures.map((failure) => (
          <li key={failure.imageName} className="flex gap-2 text-[11px]" style={{ color: COLORS.textMuted }}>
            <span className="shrink-0 font-medium" style={{ color: COLORS.text }}>
              {failure.imageName}
            </span>
            <span className="min-w-0 break-words">{failure.reason}</span>
          </li>
        ))}
      </ul>
      <div className="mt-1.5 text-[10px]" style={{ color: COLORS.textSubtle }}>
        {rateLimited
          ? "建议：等 1-2 分钟额度窗口恢复后，直接重新发送一次，无需重拍照片。"
          : "建议：调整光线与角度重拍这些位置，再发起一次识别。"}
      </div>
    </div>
  );
}

export default function ImageRecognitionResultCard({
  result,
}: {
  result: ImageRecognitionResult;
}) {
  const sorted = useMemo(() => sortedRows(result.rows), [result.rows]);
  const sourceCount = useMemo(
    () => new Set(sorted.map((row) => row.sourceImage).filter(Boolean)).size,
    [sorted],
  );

  return (
    <div className="mb-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold" style={{ color: COLORS.text }}>
            📷 货架图纸识别
          </span>
          <span className="text-[10px]" style={{ color: COLORS.textSubtle }}>
            {sorted.length} 个编号 · {sourceCount} 张照片
          </span>
        </div>
        {result.excelDownloadUrl && (
          <a
            href={result.excelDownloadUrl}
            download={result.excelFileName || undefined}
            className="inline-flex items-center gap-1.5 rounded-[10px] border px-3 py-1.5 text-[11px] font-semibold transition-all active:scale-[0.98]"
            style={{
              color: COLORS.text,
              background: COLORS.material,
              borderColor: COLORS.border,
            }}
          >
            <span aria-hidden>⬇️</span>
            下载 Excel
          </a>
        )}
      </div>

      {sorted.length > 0 ? (
        <ShelfGrid rows={sorted} />
      ) : (
        <div className="rounded-[12px] border px-3 py-2.5 text-[11px]" style={{ borderColor: COLORS.border, color: COLORS.textMuted }}>
          未识别到图纸编号。
        </div>
      )}

      <FailureList failures={result.failures} />

      {result.summary && (
        <div
          className="rounded-[12px] border px-3 py-2.5 text-[11px] whitespace-pre-wrap"
          style={{ borderColor: COLORS.border, color: COLORS.textMuted, background: COLORS.material }}
        >
          {result.summary}
        </div>
      )}
    </div>
  );
}
