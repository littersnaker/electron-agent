/**
 * 聊天输入框拖拽文字工具：兼容 Electron/Chromium 的页面选区、HTML 和纯文本拖拽。
 */

export type ComposerDropKind = "files" | "text";

export interface InsertedTextResult {
  value: string;
  caretPosition: number;
}

export const SELECTED_TEXT_MIME = "application/x-agent-selected-text";

const TEXT_MIME_TYPES = new Set([
  SELECTED_TEXT_MIME,
  "text/plain",
  "text",
  "text/html",
  "text/uri-list",
]);

/** 返回 DataTransfer 暴露的标准化 MIME 类型。 */
function readTransferTypes(dataTransfer: DataTransfer): string[] {
  return Array.from(dataTransfer.types, (type) => type.toLowerCase());
}

/** 判断当前拖拽是否包含文件；文件始终比文字优先。 */
function containsFiles(dataTransfer: DataTransfer, types: string[]): boolean {
  if (types.includes("files") || dataTransfer.files.length > 0) return true;
  return Array.from(dataTransfer.items).some((item) => item.kind === "file");
}

/** 判断输入控件自身是否存在选区，并读取选中的文字。 */
function readTextControlSelection(target: EventTarget | null): string {
  if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement)) {
    return "";
  }
  const start = target.selectionStart;
  const end = target.selectionEnd;
  if (start === null || end === null || start === end) return "";
  return target.value.slice(Math.min(start, end), Math.max(start, end));
}

/** 判断页面选区是否确实覆盖本次拖拽起点，避免使用已经失效的旧选区。 */
function selectionIntersectsTarget(selection: Selection, target: EventTarget | null): boolean {
  if (!(target instanceof Node) || selection.rangeCount === 0) return true;
  try {
    return selection.getRangeAt(0).intersectsNode(target);
  } catch {
    return false;
  }
}

/** 读取页面或 input/textarea 当前真正选中的文字。 */
export function readCurrentSelectionText(target: EventTarget | null = null): string {
  const controlText = readTextControlSelection(target);
  if (controlText) return controlText;
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selectionIntersectsTarget(selection, target)) {
    return "";
  }
  return selection.toString();
}

/** 把页面选区显式写入拖拽载荷，修复 Electron 中 text/plain 延迟出现的问题。 */
export function writeSelectedTextToTransfer(
  dataTransfer: DataTransfer,
  selectedText: string,
): void {
  if (!selectedText) return;
  try {
    dataTransfer.setData(SELECTED_TEXT_MIME, selectedText);
    dataTransfer.setData("text/plain", selectedText);
    dataTransfer.effectAllowed = "copy";
  } catch {
    // 某些系统来源的 DataTransfer 为只读，后续仍可在 drop 阶段读取原始数据。
  }
}

/** 判断拖拽内容应按附件还是纯文本处理；支持拖拽阶段类型暂时为空的情况。 */
export function resolveComposerDropKind(
  dataTransfer: DataTransfer,
  allowFiles: boolean,
  selectedTextFallback = "",
): ComposerDropKind | null {
  const types = readTransferTypes(dataTransfer);
  const hasFiles = containsFiles(dataTransfer, types);
  if (hasFiles) return allowFiles ? "files" : null;

  const hasTextType = types.some((type) => TEXT_MIME_TYPES.has(type));
  const hasStringItem = Array.from(dataTransfer.items).some(
    (item) => item.kind === "string",
  );
  if (hasTextType || hasStringItem || selectedTextFallback) return "text";

  // Chromium 在页面选区刚进入目标区域时可能暂不公开 MIME；允许 drop 后再读取。
  if (types.length === 0 && dataTransfer.items.length === 0) return "text";
  return null;
}

/** 把 HTML 拖拽内容转换为可编辑纯文本，并尽量保留块级换行。 */
function convertHtmlToText(html: string): string {
  if (!html) return "";
  const normalized = html
    .replace(/<br\s*\/?\s*>/giu, "\n")
    .replace(/<\/(?:p|div|li|h[1-6]|blockquote|pre)>/giu, "\n");
  const parsed = new DOMParser().parseFromString(normalized, "text/html");
  return (parsed.body.textContent || "").replace(/\n{3,}/gu, "\n\n");
}

/** 从不同浏览器和桌面应用的 DataTransfer 中读取可编辑文字。 */
export function readDroppedText(
  dataTransfer: DataTransfer,
  selectedTextFallback = "",
): string {
  const directText =
    dataTransfer.getData(SELECTED_TEXT_MIME) ||
    dataTransfer.getData("text/plain") ||
    dataTransfer.getData("text");
  if (directText) return directText.replace(/\r\n?/gu, "\n");

  const htmlText = convertHtmlToText(dataTransfer.getData("text/html"));
  if (htmlText) return htmlText;

  const uriText = dataTransfer
    .getData("text/uri-list")
    .split(/\r?\n/gu)
    .filter((line) => line && !line.startsWith("#"))
    .join("\n");
  return uriText || selectedTextFallback;
}

/** 在文本框当前选区插入拖入文字，并返回新的光标位置。 */
export function insertTextAtSelection(
  currentValue: string,
  insertedText: string,
  selectionStart: number,
  selectionEnd: number,
): InsertedTextResult {
  const safeStart = Math.max(0, Math.min(selectionStart, currentValue.length));
  const safeEnd = Math.max(safeStart, Math.min(selectionEnd, currentValue.length));
  const value = `${currentValue.slice(0, safeStart)}${insertedText}${currentValue.slice(safeEnd)}`;
  return {
    value,
    caretPosition: safeStart + insertedText.length,
  };
}
