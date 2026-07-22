/**
 * 附件 RAG 使用的公共类型。
 *
 * 这一层不依赖 React、Next.js 或具体模型，因此可以同时在客户端与服务端复用。
 */

export interface RagChunk {
  /** 当前切片在原文中的顺序。 */
  index: number;

  /** 当前切片的正文。 */
  text: string;

  /** 当前切片分词后的总词数。 */
  tokenCount: number;

  /** 当前切片每个词的出现次数。 */
  termFrequency: ReadonlyMap<string, number>;
}

export interface RagDocumentIndex {
  /** 文档切片。 */
  chunks: readonly RagChunk[];

  /** 全部切片的平均词数，用于 BM25 长度归一化。 */
  averageTokenCount: number;

  /** 每个词出现在多少个切片中。 */
  documentFrequency: ReadonlyMap<string, number>;
}

export interface RagSearchResult {
  /** 命中的切片。 */
  chunk: RagChunk;

  /** BM25 风格相关度分数。 */
  score: number;
}

export interface RagRetrievalOptions {
  /** 最多返回多少个切片。 */
  topK?: number;

  /** 发送给模型的上下文最大字符数。 */
  maxContextCharacters?: number;

  /** 小于该长度的附件直接原样发送，不执行 RAG。 */
  minimumContentCharacters?: number;
}

export interface AttachmentRagMetadata {
  /** 是否执行了附件 RAG。 */
  enabled: boolean;

  /** 实际命中的切片数量。 */
  retrievedChunkCount: number;

  /** 原始附件总字符数。 */
  originalCharacterCount: number;

  /** 最终发送给模型的字符数。 */
  contextCharacterCount: number;
}
