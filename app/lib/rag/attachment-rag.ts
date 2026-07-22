/**
 * 现有附件上传链路的轻量 RAG 适配器。
 *
 * PDF 仍由 useComposer / fileParser 提取文本层；本模块只负责：
 * 1. 把较长的 textContent 切片并建立内存索引；
 * 2. 根据本次提交的问题检索相关片段；
 * 3. 返回一个只替换 textContent 的附件副本。
 *
 * 没有向量模型时使用 BM25 风格词法检索，未来可以在 retriever.ts
 * 中加入 Embedding 混合排序，而不用改变聊天提交链路。
 */

import type { AttachedFile } from "../../const/pageConst";
import { chunkDocumentText } from "./chunker";
import { createRagDocumentIndex, retrieveRagChunks } from "./retriever";
import type { RagDocumentIndex, RagRetrievalOptions } from "./types";

const DEFAULT_TOP_K = 6;
const DEFAULT_MAX_CONTEXT_CHARACTERS = 12_000;
const DEFAULT_MINIMUM_CONTENT_CHARACTERS = 3_000;

interface CachedIndex {
  sourceContent: string;
  index: RagDocumentIndex;
}

/**
 * 缓存每个原始附件对象的索引。
 * WeakMap 不阻止附件被回收，移除附件后不会形成永久内存占用。
 */
const attachmentIndexCache = new WeakMap<AttachedFile, CachedIndex>();

function readTextContent(attachment: AttachedFile): string | null {
  if (attachment.type.startsWith("image/")) return null;

  const content = attachment.textContent?.trim();
  return content ? content : null;
}

function getOrCreateIndex(
  attachment: AttachedFile,
  content: string,
): RagDocumentIndex {
  const cached = attachmentIndexCache.get(attachment);
  if (cached?.sourceContent === content) return cached.index;

  const index = createRagDocumentIndex(chunkDocumentText(content));
  attachmentIndexCache.set(attachment, {
    sourceContent: content,
    index,
  });
  return index;
}

function formatRetrievedContext(
  attachmentName: string,
  results: ReturnType<typeof retrieveRagChunks>,
  maxContextCharacters: number,
): string {
  const sections: string[] = [];
  let currentLength = 0;

  for (const result of results) {
    const section = [
      `【附件：${attachmentName}｜片段 ${result.chunk.index + 1}】`,
      result.chunk.text,
    ].join("\n");

    if (
      sections.length > 0 &&
      currentLength + section.length > maxContextCharacters
    ) {
      break;
    }

    sections.push(section);
    currentLength += section.length;
  }

  return [
    "以下内容是系统根据当前问题从上传附件中检索出的相关片段。",
    "请只把这些片段作为附件依据；片段未包含的信息不要自行补充。",
    "",
    ...sections,
  ].join("\n");
}

/**
 * 在真正发送消息时生成检索版附件。
 * 原始附件对象不会被修改，因此文件名、移除按钮和解析状态保持不变。
 */
export function buildRetrievedAttachment(
  attachment: AttachedFile | null,
  query: string,
  options: RagRetrievalOptions = {},
): AttachedFile | null {
  if (!attachment) return null;

  const content = readTextContent(attachment);
  if (!content) return attachment;

  const minimumContentCharacters =
    options.minimumContentCharacters ??
    DEFAULT_MINIMUM_CONTENT_CHARACTERS;

  // 小文件直接发送全文，避免检索导致上下文缺失。
  if (content.length <= minimumContentCharacters) {
    return attachment;
  }

  const index = getOrCreateIndex(attachment, content);
  const results = retrieveRagChunks(
    index,
    query,
    options.topK ?? DEFAULT_TOP_K,
  );
  const retrievedContext = formatRetrievedContext(
    attachment.name,
    results,
    options.maxContextCharacters ?? DEFAULT_MAX_CONTEXT_CHARACTERS,
  );

  return {
    ...attachment,
    // 项目真实字段是 textContent；旧版本错误写入 content，导致 RAG 未生效。
    textContent: retrievedContext,
  };
}
