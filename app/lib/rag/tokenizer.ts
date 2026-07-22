/**
 * 轻量级中英文分词器。
 *
 * 当前项目没有向量模型，因此使用词法检索：
 * - 英文、数字和代码标识符按单词处理；
 * - 中文同时生成单字与双字词，以兼顾召回率和短语匹配；
 * - 保留重复词，供 BM25 计算词频。
 */

const LATIN_TOKEN_PATTERN = /[a-z0-9_./:-]+/giu;
const CJK_SEQUENCE_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff]+/gu;

/**
 * 统一文本格式，降低全角、大小写和空白差异对检索的影响。
 */
export function normalizeRagText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * 将文本转换为适合词法检索的 token 列表。
 */
export function tokenizeForRag(value: string): string[] {
  const normalized = normalizeRagText(value);

  if (!normalized) {
    return [];
  }

  const tokens: string[] = [];

  for (const match of normalized.matchAll(LATIN_TOKEN_PATTERN)) {
    const token = match[0]?.trim();

    if (token) {
      tokens.push(token);
    }
  }

  for (const match of normalized.matchAll(CJK_SEQUENCE_PATTERN)) {
    const sequence = match[0] ?? "";
    const characters = Array.from(sequence);

    for (const character of characters) {
      tokens.push(character);
    }

    for (let index = 0; index < characters.length - 1; index += 1) {
      tokens.push(`${characters[index]}${characters[index + 1]}`);
    }
  }

  return tokens;
}

/**
 * 统计 token 在一个切片中的出现次数。
 */
export function buildTermFrequency(
  tokens: readonly string[],
): ReadonlyMap<string, number> {
  const frequency = new Map<string, number>();

  for (const token of tokens) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }

  return frequency;
}
