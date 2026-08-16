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

/** 把“第1层”/“第2位”这类中文序号统一成排序可用的数字键。 */
function indexOfChinesePosition(value: string): number {
  const match = /第\s*(\d+)\s*[层位]/.exec(value || "");
  return match ? Number.parseInt(match[1], 10) : 0;
}

/** 按层号、位号排序识别行，保证矩阵渲染与 Excel 顺序一致。 */
function sortedRows(rows: ImageRecognitionRow[]): ImageRecognitionRow[] {
  return [...rows].sort(
    (a, b) =>
      indexOfChinesePosition(a.row) - indexOfChinesePosition(b.row) ||
      indexOfChinesePosition(a.col) - indexOfChinesePosition(b.col) ||
      a.sheetNo.localeCompare(b.sheetNo, "zh-CN"),
  );
}

function MatrixGrid({ rows }: { rows: ImageRecognitionRow[] }) {
  const maxRow = useMemo(
    () => Math.max(1, ...rows.map((row) => indexOfChinesePosition(row.row))),
    [rows],
  );
  const maxCol = useMemo(
    () => Math.max(1, ...rows.map((row) => indexOfChinesePosition(row.col))),
    [rows],
  );
  const sorted = useMemo(() => sortedRows(rows), [rows]);
  const matrix: Array<Array<ImageRecognitionRow | undefined>> = useMemo(() => {
    const grid: Array<Array<ImageRecognitionRow | undefined>> = [];
    for (let rowIndex = 1; rowIndex <= maxRow; rowIndex += 1) {
      grid[rowIndex] = [];
      for (let colIndex = 1; colIndex <= maxCol; colIndex += 1) {
        grid[rowIndex][colIndex] = sorted.find(
          (item) =>
            indexOfChinesePosition(item.row) === rowIndex &&
            indexOfChinesePosition(item.col) === colIndex,
        );
      }
    }
    return grid;
  }, [maxRow, maxCol, sorted]);

  return (
    <div className="w-full overflow-x-auto">
      <table className="w-full border-collapse text-center">
        <thead>
          <tr>
            <th
              className="border px-2 py-1.5 text-[10px] font-semibold"
              style={{ borderColor: COLORS.border, color: COLORS.textSubtle }}
            >
              层 \\ 位
            </th>
            {Array.from({ length: maxCol }, (_, index) => (
              <th
                key={index}
                className="border px-2 py-1.5 text-[10px] font-semibold"
                style={{ borderColor: COLORS.border, color: COLORS.textSubtle }}
              >
                第{index + 1}位
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: maxRow }, (_, rowIndex) => {
            const rowNumber = rowIndex + 1;
            return (
              <tr key={rowNumber}>
                <td
                  className="border px-2 py-1.5 text-[10px] font-semibold"
                  style={{ borderColor: COLORS.border, color: COLORS.textSubtle }}
                >
                  第{rowNumber}层
                </td>
                {Array.from({ length: maxCol }, (_, colIndex) => {
                  const cell = matrix[rowNumber]?.[colIndex + 1];
                  if (!cell) {
                    return (
                      <td
                        key={colIndex}
                        className="border px-2 py-2"
                        style={{ borderColor: COLORS.border, background: "color-mix(in srgb, var(--app-bg) 55%, transparent)" }}
                      >
                        <span
                          className="inline-block h-1.5 w-1.5 rounded-full"
                          style={{ background: "color-mix(in srgb, var(--text-tertiary) 40%, transparent)" }}
                        />
                      </td>
                    );
                  }
                  return (
                    <td
                      key={colIndex}
                      className="border px-2 py-2"
                      style={{
                        borderColor: COLORS.border,
                        background: "color-mix(in srgb, var(--accent-blue-soft) 55%, transparent)",
                      }}
                      title={`${cell.sheetNo} · ${cell.sourceImage}${cell.note ? ` · ${cell.note}` : ""}`}
                    >
                      <span className="block text-[13px] font-semibold tracking-[-0.01em]" style={{ color: COLORS.blue }}>
                        {cell.sheetNo}
                      </span>
                      {cell.note && (
                        <span className="mt-0.5 block text-[9px]" style={{ color: COLORS.amber }}>
                          {cell.note}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FailureList({ failures }: { failures: ImageRecognitionFailure[] }) {
  if (failures.length === 0) return null;
  return (
    <div
      className="mt-3 rounded-[12px] border px-3 py-2.5"
      style={{ borderColor: "color-mix(in srgb, var(--accent-red) 35%, var(--border))" }}
    >
      <div className="text-[11px] font-semibold" style={{ color: COLORS.red }}>
        ⚠️ {failures.length} 张照片识别失败（已跳过，未影响其他照片）
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
        建议：调整光线与角度重拍这些位置，再发起一次识别。
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
        <MatrixGrid rows={sorted} />
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
