/**
 * 将已提取的 PDF / 文本文档内容切成适合检索的片段。
 *
 * 注意：
 * - 这里不负责读取 PDF；
 * - 继续沿用项目现有的 PDF 文字提取逻辑；
 * - 本模块只接收提取完成后的字符串。
 */

import type { RagChunk } from "./types";
import { buildTermFrequency, tokenizeForRag } from "./tokenizer";

const DEFAULT_TARGET_CHARACTERS = 1_200;
const DEFAULT_MAX_CHARACTERS = 1_800;
const DEFAULT_OVERLAP_CHARACTERS = 180;

interface ChunkTextOptions {
  targetCharacters?: number;
  maxCharacters?: number;
  overlapCharacters?: number;
}

/**
 * 清理 PDF 提取常见的断行和多余空白。
 */
function normalizeDocumentText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/**
 * 按空行拆成段落；如果原文没有段落，则按行处理。
 */
function splitParagraphs(value: string): string[] {
  const paragraphs = value
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.replace(/\s*\n\s*/gu, " ").trim())
    .filter(Boolean);

  if (paragraphs.length > 1) {
    return paragraphs;
  }

  return value
    .split(/\n+/gu)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * 为下一段生成少量重叠文本，避免答案刚好跨越切片边界。
 */
function buildOverlap(value: string, overlapCharacters: number): string {
  if (overlapCharacters <= 0 || value.length <= overlapCharacters) {
    return value;
  }

  return value.slice(-overlapCharacters);
}

/**
 * 把一个超长段落按最大长度继续拆开。
 */
function splitLongParagraph(
  paragraph: string,
  maxCharacters: number,
  overlapCharacters: number,
): string[] {
  if (paragraph.length <= maxCharacters) {
    return [paragraph];
  }

  const parts: string[] = [];
  let cursor = 0;

  while (cursor < paragraph.length) {
    const end = Math.min(cursor + maxCharacters, paragraph.length);
    const part = paragraph.slice(cursor, end).trim();

    if (part) {
      parts.push(part);
    }

    if (end >= paragraph.length) {
      break;
    }

    cursor = Math.max(end - overlapCharacters, cursor + 1);
  }

  return parts;
}

/**
 * 将文档正文转换为带词频信息的检索切片。
 */
export function chunkDocumentText(
  rawText: string,
  options: ChunkTextOptions = {},
): RagChunk[] {
  const targetCharacters =
    options.targetCharacters ?? DEFAULT_TARGET_CHARACTERS;
  const maxCharacters = options.maxCharacters ?? DEFAULT_MAX_CHARACTERS;
  const overlapCharacters =
    options.overlapCharacters ?? DEFAULT_OVERLAP_CHARACTERS;

  const normalized = normalizeDocumentText(rawText);

  if (!normalized) {
    return [];
  }

  const paragraphs = splitParagraphs(normalized).flatMap((paragraph) =>
    splitLongParagraph(paragraph, maxCharacters, overlapCharacters),
  );

  const chunkTexts: string[] = [];
  let current = "";

  const flushCurrent = (): void => {
    const trimmed = current.trim();

    if (trimmed) {
      chunkTexts.push(trimmed);
    }

    current = "";
  };

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;

    if (candidate.length <= targetCharacters) {
      current = candidate;
      continue;
    }

    if (current) {
      const overlap = buildOverlap(current, overlapCharacters);
      flushCurrent();
      current = overlap ? `${overlap}\n\n${paragraph}` : paragraph;
    } else {
      current = paragraph;
    }

    if (current.length >= maxCharacters) {
      flushCurrent();
    }
  }

  flushCurrent();

  return chunkTexts.map((text, index) => {
    const tokens = tokenizeForRag(text);

    return {
      index,
      text,
      tokenCount: Math.max(tokens.length, 1),
      termFrequency: buildTermFrequency(tokens),
    };
  });
}
