/**
 * 不依赖向量模型的 BM25 风格检索器。
 *
 * 当前版本的目标是：
 * - PDF 上传后不再把全部正文塞给 LLM；
 * - 根据用户当前问题，只选择最相关的若干切片；
 * - 等未来有 Embedding 模型时，可在这一层增加混合检索。
 */

import type {
  RagChunk,
  RagDocumentIndex,
  RagSearchResult,
} from "./types";
import { normalizeRagText, tokenizeForRag } from "./tokenizer";

const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * 为一组切片创建可重复使用的词法索引。
 */
export function createRagDocumentIndex(
  chunks: readonly RagChunk[],
): RagDocumentIndex {
  const documentFrequency = new Map<string, number>();

  for (const chunk of chunks) {
    for (const term of chunk.termFrequency.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  const totalTokenCount = chunks.reduce(
    (sum, chunk) => sum + chunk.tokenCount,
    0,
  );

  return {
    chunks,
    averageTokenCount:
      chunks.length > 0 ? totalTokenCount / chunks.length : 1,
    documentFrequency,
  };
}

/**
 * 计算一个词在当前切片中的 BM25 分数。
 */
function scoreTerm(
  term: string,
  chunk: RagChunk,
  index: RagDocumentIndex,
): number {
  const termFrequency = chunk.termFrequency.get(term) ?? 0;

  if (termFrequency <= 0) {
    return 0;
  }

  const documentCount = Math.max(index.chunks.length, 1);
  const matchingDocumentCount =
    index.documentFrequency.get(term) ?? 0;

  const inverseDocumentFrequency = Math.log(
    1 +
      (documentCount - matchingDocumentCount + 0.5) /
        (matchingDocumentCount + 0.5),
  );

  const lengthNormalization =
    1 -
    BM25_B +
    BM25_B *
      (chunk.tokenCount / Math.max(index.averageTokenCount, 1));

  return (
    inverseDocumentFrequency *
    ((termFrequency * (BM25_K1 + 1)) /
      (termFrequency + BM25_K1 * lengthNormalization))
  );
}

/**
 * 检索与问题最相关的切片。
 */
export function retrieveRagChunks(
  index: RagDocumentIndex,
  query: string,
  topK: number,
): RagSearchResult[] {
  if (index.chunks.length === 0 || topK <= 0) {
    return [];
  }

  const normalizedQuery = normalizeRagText(query);
  const queryTokens = tokenizeForRag(normalizedQuery);
  const uniqueTerms = Array.from(new Set(queryTokens));

  /**
   * 用户只上传文件但没有输入问题时，保留文档最前面的切片。
   * 这样“总结这个文件”一类空输入场景仍有合理上下文。
   */
  if (uniqueTerms.length === 0) {
    return index.chunks.slice(0, topK).map((chunk) => ({
      chunk,
      score: 0,
    }));
  }

  const scored = index.chunks.map((chunk) => {
    const lexicalScore = uniqueTerms.reduce(
      (sum, term) => sum + scoreTerm(term, chunk, index),
      0,
    );

    /**
     * 完整查询短语直接出现在切片中时给予少量加权。
     * 这对合同条款名、函数名和产品名称尤其有用。
     */
    const phraseBoost =
      normalizedQuery.length >= 2 &&
      normalizeRagText(chunk.text).includes(normalizedQuery)
        ? 2
        : 0;

    return {
      chunk,
      score: lexicalScore + phraseBoost,
    };
  });

  const positiveResults = scored
    .filter((result) => result.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      return left.chunk.index - right.chunk.index;
    });

  if (positiveResults.length > 0) {
    return positiveResults.slice(0, topK);
  }

  /**
   * 没有任何词命中时，返回开头切片作为保守降级，
   * 避免把整篇 PDF 再次发送给模型。
   */
  return index.chunks.slice(0, topK).map((chunk) => ({
    chunk,
    score: 0,
  }));
}
