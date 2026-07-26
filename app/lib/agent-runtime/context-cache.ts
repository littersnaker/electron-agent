// 模块说明：负责 context cache 核心服务与领域逻辑。
import { createHash } from "crypto";
import fs from "fs";
import path from "path";

/**
 * 上下文缓存命名空间。
 *
 * 不同 Agent 的输出语义不同，必须分开缓存，避免同一个 key 在 Search/File
 * 之间发生错误复用。
 */
export type ContextCacheNamespace = "search" | "file" | "merged";

export interface ContextCacheLookup {
  namespace: ContextCacheNamespace;
  projectId: string;
  workingDir: string;
  userRequest: string;
  /**
   * 与本次上下文强相关的文件路径。
   * File Agent 会把用户点名文件传进来，让文件 mtime/size 参与缓存指纹。
   */
  dependencyPaths?: readonly string[];
}

export interface ContextCacheResult {
  hit: boolean;
  value: string | null;
  ageMs: number;
  key: string;
}

interface ContextCacheEntry {
  value: string;
  createdAtMs: number;
  expiresAtMs: number;
  projectId: string;
  namespace: ContextCacheNamespace;
}

interface ContextCacheStore {
  entries: Map<string, ContextCacheEntry>;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 128;
const DEFAULT_MAX_VALUE_CHARACTERS = 16_000;
const GLOBAL_CACHE_KEY = Symbol.for("multi-agent.context-cache.v1");

type GlobalWithContextCache = typeof globalThis & {
  [GLOBAL_CACHE_KEY]?: ContextCacheStore;
};

function getStore(): ContextCacheStore {
  const globalScope = globalThis as GlobalWithContextCache;
  if (!globalScope[GLOBAL_CACHE_KEY]) {
    globalScope[GLOBAL_CACHE_KEY] = {
      entries: new Map(),
      hits: 0,
      misses: 0,
      writes: 0,
      evictions: 0,
    };
  }
  return globalScope[GLOBAL_CACHE_KEY];
}

function readPositiveInteger(
  environmentName: string,
  fallback: number,
): number {
  const parsed = Number.parseInt(process.env[environmentName] || "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizePath(value: string): string {
  return value.replace(/\\/gu, "/").replace(/^\.\//u, "");
}

function readPathFingerprint(
  workingDir: string,
  dependencyPath: string,
): string {
  try {
    const root = path.resolve(workingDir);
    const candidate = path.resolve(root, dependencyPath);
    const relative = path.relative(root, candidate);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      return `${normalizePath(dependencyPath)}:outside-workspace`;
    }

    const stat = fs.statSync(candidate);
    return [
      normalizePath(dependencyPath),
      stat.isDirectory() ? "directory" : "file",
      stat.size,
      Math.floor(stat.mtimeMs),
    ].join(":");
  } catch {
    return `${normalizePath(dependencyPath)}:missing`;
  }
}

/**
 * 生成稳定缓存 key。
 *
 * key 同时包含项目、请求、工作目录和依赖文件指纹。这样只要目标文件被修改，
 * 即使用户重复相同问题，也不会命中旧上下文。
 */
export function createContextCacheKey(lookup: ContextCacheLookup): string {
  const dependencies = Array.from(
    new Set((lookup.dependencyPaths || []).map(normalizePath)),
  )
    .sort()
    .map((dependencyPath) =>
      readPathFingerprint(lookup.workingDir, dependencyPath),
    );

  const payload = JSON.stringify({
    namespace: lookup.namespace,
    projectId: lookup.projectId || "unbound-project",
    workingDir: path.resolve(lookup.workingDir || process.cwd()),
    userRequest: lookup.userRequest.trim().replace(/\s+/gu, " "),
    dependencies,
  });

  return createHash("sha256").update(payload).digest("hex");
}

function deleteExpiredEntries(store: ContextCacheStore, now: number): void {
  for (const [key, entry] of store.entries) {
    if (entry.expiresAtMs > now) continue;
    store.entries.delete(key);
    store.evictions += 1;
  }
}

function enforceCapacity(store: ContextCacheStore): void {
  const maxEntries = readPositiveInteger(
    "AGENT_CONTEXT_CACHE_MAX_ENTRIES",
    DEFAULT_MAX_ENTRIES,
  );

  while (store.entries.size > maxEntries) {
    const oldestKey = store.entries.keys().next().value as string | undefined;
    if (!oldestKey) return;
    store.entries.delete(oldestKey);
    store.evictions += 1;
  }
}

/** 读取缓存；命中时会把条目移动到 Map 尾部，形成轻量 LRU。 */
export function readContextCache(
  lookup: ContextCacheLookup,
): ContextCacheResult {
  const store = getStore();
  const now = Date.now();
  deleteExpiredEntries(store, now);

  const key = createContextCacheKey(lookup);
  const entry = store.entries.get(key);
  if (!entry) {
    store.misses += 1;
    return { hit: false, value: null, ageMs: 0, key };
  }

  store.entries.delete(key);
  store.entries.set(key, entry);
  store.hits += 1;
  return {
    hit: true,
    value: entry.value,
    ageMs: Math.max(0, now - entry.createdAtMs),
    key,
  };
}

/** 写入有界 TTL 缓存，超长上下文会先截断，防止缓存本身成为内存膨胀源。 */
export function writeContextCache(
  lookup: ContextCacheLookup,
  value: string,
): string {
  const store = getStore();
  const now = Date.now();
  const ttlMs = readPositiveInteger(
    "AGENT_CONTEXT_CACHE_TTL_MS",
    DEFAULT_TTL_MS,
  );
  const maxCharacters = readPositiveInteger(
    "AGENT_CONTEXT_CACHE_MAX_VALUE_CHARS",
    DEFAULT_MAX_VALUE_CHARACTERS,
  );
  const key = createContextCacheKey(lookup);

  store.entries.delete(key);
  store.entries.set(key, {
    value: value.slice(0, maxCharacters),
    createdAtMs: now,
    expiresAtMs: now + ttlMs,
    projectId: lookup.projectId || "unbound-project",
    namespace: lookup.namespace,
  });
  store.writes += 1;
  enforceCapacity(store);
  return key;
}

/**
 * 文件写入成功后按项目失效缓存。
 *
 * 这里不尝试精确推断哪些查询受影响：项目级失效更保守，也避免旧索引结果被误用。
 */
export function invalidateProjectContextCache(projectId: string): number {
  const normalizedProjectId = projectId || "unbound-project";
  const store = getStore();
  let removed = 0;

  for (const [key, entry] of store.entries) {
    if (entry.projectId !== normalizedProjectId) continue;
    store.entries.delete(key);
    removed += 1;
  }
  store.evictions += removed;
  return removed;
}

/** 提供给可观测接口的轻量统计，不暴露缓存正文。 */
export function getContextCacheStats(): {
  entries: number;
  hits: number;
  misses: number;
  writes: number;
  evictions: number;
  hitRate: number;
} {
  const store = getStore();
  deleteExpiredEntries(store, Date.now());
  const totalReads = store.hits + store.misses;
  return {
    entries: store.entries.size,
    hits: store.hits,
    misses: store.misses,
    writes: store.writes,
    evictions: store.evictions,
    hitRate: totalReads > 0 ? store.hits / totalReads : 0,
  };
}
