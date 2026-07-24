"use client";

import type { CommerceResearchReport } from "./types";
import {
  buildCommercePdfFileName,
  buildCommerceReportHtml,
} from "./report-html";

interface ElectronPdfResult {
  canceled: boolean;
  filePath?: string;
}

interface CommerceElectronApi {
  exportCommerceReportPdf?: (payload: {
    html: string;
    suggestedFileName: string;
  }) => Promise<ElectronPdfResult>;
}

/**
 * 导出市场研究 PDF。
 *
 * Electron 使用 Chromium printToPDF 直接生成真实 PDF；普通浏览器没有本地文件系统
 * IPC，因此退化为系统打印窗口，用户可选择“另存为 PDF”。两条路径都复用同一份 HTML。
 */
export async function exportCommerceReportPdf(
  report: CommerceResearchReport,
): Promise<ElectronPdfResult> {
  const html = buildCommerceReportHtml(report);
  const suggestedFileName = buildCommercePdfFileName(report);
  const electronApi = (
    window as typeof window & { electronAPI?: CommerceElectronApi }
  ).electronAPI;

  if (electronApi?.exportCommerceReportPdf) {
    return electronApi.exportCommerceReportPdf({ html, suggestedFileName });
  }

  const printWindow = window.open("", "_blank", "noopener,noreferrer");
  if (!printWindow) {
    throw new Error("浏览器阻止了报告窗口，请允许弹出窗口后重试。");
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  window.setTimeout(() => printWindow.print(), 180);
  return { canceled: false };
}
