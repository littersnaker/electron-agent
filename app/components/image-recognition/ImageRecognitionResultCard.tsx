// 模块说明：图片识别结果卡片（货架矩阵 层×叠放排×货位 + 失败清单 + Excel 下载）。
"use client";

import { useMemo } from "react";
import type {
  ImageRecognitionFailure,
  ImageRecognitionLayer,
  ImageRecognitionResult,
} from "../../constants/page-constants";
import { buildApiUrl } from "../../lib/api-client";

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

const EMPTY_RESULT: ImageRecognitionResult = {
  layers: [],
  failures: [],
  summary: "",
  excelFileName: "",
  excelDownloadUrl: "",
};

/**
 * 归一化识别结果：SQLite 里可能保存着旧版本（rows 结构）或损坏的消息，
 * 渲染前统一兜底，避免 result.layers 为 undefined 导致整页崩溃。
 */
function normalizeResult(result: ImageRecognitionResult | undefined): {
  result: ImageRecognitionResult;
  legacy: boolean;
} {
  if (!result || typeof result !== "object") {
    return { result: EMPTY_RESULT, legacy: false };
  }
  const legacy = !Array.isArray((result as { layers?: unknown }).layers);
  if (legacy) {
    return { result: EMPTY_RESULT, legacy: true };
  }
  const safeLayers = (result.layers as ImageRecognitionLayer[]).map((layer) => ({
    layer: Number(layer?.layer) || 0,
    maxStack: Math.max(1, Number(layer?.maxStack) || 1),
    maxPosition: Math.max(1, Number(layer?.maxPosition) || 1),
    cells: Array.isArray(layer?.cells)
      ? (layer.cells as ImageRecognitionLayer["cells"]).map((row) =>
          Array.isArray(row) ? row : [],
        )
      : [],
  }));
  return {
    result: {
      layers: safeLayers,
      failures: Array.isArray(result.failures) ? result.failures : [],
      summary: typeof result.summary === "string" ? result.summary : "",
      excelFileName:
        typeof result.excelFileName === "string" ? result.excelFileName : "",
      excelDownloadUrl:
        typeof result.excelDownloadUrl === "string" ? result.excelDownloadUrl : "",
    },
    legacy: false,
  };
}

/** 一层货架网格：每行一个叠放排、每列一个货位，看不清的格子留空。 */
function LayerGrid({ layer }: { layer: ImageRecognitionLayer }) {
  const maxStack = Math.max(1, layer.maxStack);
  const maxPosition = Math.max(1, layer.maxPosition);

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-center">
        <thead>
          <tr>
            <th
              className="border px-1.5 py-1 text-[10px] font-semibold"
              style={{ borderColor: COLORS.border, color: COLORS.textSubtle }}
            >
              排 \\ 位
            </th>
            {Array.from({ length: maxPosition }, (_, index) => (
              <th
                key={index}
                className="border px-1.5 py-1 text-[10px] font-semibold"
                style={{ borderColor: COLORS.border, color: COLORS.textSubtle }}
              >
                {index + 1}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: maxStack }, (_, stackIndex) => {
            const row = stackIndex + 1;
            return (
              <tr key={row}>
                <td
                  className="border px-1.5 py-1 text-[10px] font-semibold"
                  style={{ borderColor: COLORS.border, color: COLORS.textSubtle }}
                >
                  排{row}
                </td>
                {Array.from({ length: maxPosition }, (_, positionIndex) => {
                  const cell = layer.cells?.[stackIndex]?.[positionIndex];
                  if (!cell) {
                    return (
                      <td
                        key={positionIndex}
                        className="border px-1.5 py-1.5"
                        style={{
                          borderColor: COLORS.border,
                          background: "color-mix(in srgb, var(--app-bg) 55%, transparent)",
                        }}
                      />
                    );
                  }
                  if (!cell.sheetNo) {
                    // 占位格：位置存在但编号无法辨认，用"空"标识让用户知道这里没读出来。
                    return (
                      <td
                        key={positionIndex}
                        className="border px-1.5 py-1.5"
                        style={{
                          borderColor: COLORS.border,
                          background: "color-mix(in srgb, var(--app-bg) 70%, transparent)",
                        }}
                        title={`${cell.note || "编号无法辨认"} · ${cell.sourceImage}`}
                      >
                        <span className="text-[11px] italic" style={{ color: COLORS.textSubtle }}>
                          空
                        </span>
                      </td>
                    );
                  }
                  return (
                    <td
                      key={positionIndex}
                      className="border px-1.5 py-1.5"
                      style={{
                        borderColor: COLORS.border,
                        background: "color-mix(in srgb, var(--accent-blue-soft) 55%, transparent)",
                      }}
                      title={`${cell.sheetNo} · ${cell.sourceImage}${cell.note ? ` · ${cell.note}` : ""}`}
                    >
                      <span className="text-[13px] font-semibold tracking-[-0.01em]" style={{ color: COLORS.blue }}>
                        {cell.sheetNo}
                      </span>
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

function ShelfGrid({ layers }: { layers: ImageRecognitionLayer[] }) {
  const sorted = useMemo(
    () => [...layers].sort((a, b) => a.layer - b.layer),
    [layers],
  );
  const totalSheets = useMemo(
    () =>
      sorted.reduce(
        (sum, layer) =>
          sum +
          layer.cells.reduce(
            (inner, row) =>
              inner +
              row.filter((cell) => cell !== null && Boolean(cell.sheetNo)).length,
            0,
          ),
        0,
      ),
    [sorted],
  );

  return (
    <div className="space-y-2">
      {sorted.map((layer) => (
        <div
          key={layer.layer}
          className="rounded-[12px] border px-3 py-2"
          style={{
            borderColor: COLORS.border,
            background: "color-mix(in srgb, var(--glass) 45%, transparent)",
          }}
        >
          <div
            className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.1em]"
            style={{ color: COLORS.textSubtle }}
          >
            第{layer.layer}层
          </div>
          <LayerGrid layer={layer} />
        </div>
      ))}
      <div className="text-[10px]" style={{ color: COLORS.textSubtle }}>
        共 {totalSheets} 个编号；看不清/不确定的位置以“空”标记。
      </div>
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
          : `⚠️ ${failures.length} 处未识别（已留空，未影响其他位置）`}
      </div>
      <ul className="mt-1.5 space-y-1">
        {failures.map((failure) => (
          <li key={`${failure.imageName}-${failure.reason}`} className="flex gap-2 text-[11px]" style={{ color: COLORS.textMuted }}>
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
  const { result: safeResult, legacy } = useMemo(
    () => normalizeResult(result),
    [result],
  );
  const totalSheets = useMemo(
    () =>
      safeResult.layers.reduce(
        (sum, layer) =>
          sum +
          layer.cells.reduce(
            (inner, row) =>
              inner +
              row.filter((cell) => cell !== null && Boolean(cell.sheetNo)).length,
            0,
          ),
        0,
      ),
    [safeResult.layers],
  );

  if (legacy) {
    return (
      <div className="mb-3 rounded-[12px] border px-3 py-2.5 text-[11px]" style={{ borderColor: COLORS.border, color: COLORS.textMuted }}>
        ⚠️ 此结果来自旧版本格式，无法以矩阵展示。请重新上传照片识别一次。
      </div>
    );
  }

  return (
    <div className="mb-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold" style={{ color: COLORS.text }}>
            📷 货架图纸识别
          </span>
          <span className="text-[10px]" style={{ color: COLORS.textSubtle }}>
            {totalSheets} 个编号 · {safeResult.layers.length} 层
          </span>
        </div>
        {safeResult.excelDownloadUrl && (
          <a
            href={buildApiUrl(safeResult.excelDownloadUrl)}
            download={safeResult.excelFileName || undefined}
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

      {safeResult.layers.length > 0 ? (
        <ShelfGrid layers={safeResult.layers} />
      ) : (
        <div className="rounded-[12px] border px-3 py-2.5 text-[11px]" style={{ borderColor: COLORS.border, color: COLORS.textMuted }}>
          未识别到图纸编号。
        </div>
      )}

      <FailureList failures={safeResult.failures} />

      {safeResult.summary && (
        <div
          className="rounded-[12px] border px-3 py-2.5 text-[11px] whitespace-pre-wrap"
          style={{ borderColor: COLORS.border, color: COLORS.textMuted, background: COLORS.material }}
        >
          {safeResult.summary}
        </div>
      )}
    </div>
  );
}
