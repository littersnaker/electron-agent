/**
 * 项目级长期记忆仓储。
 *
 * 只有经过 Reflection 验证、具有跨任务复用价值的内容才会进入该表。
 * STM 由消息窗口生成，WM 由 LangGraph State 保存，因此二者不需要数据库持久化。
 */
import { createHash, randomUUID } from "crypto";
import {
  clampMemoryImportance,
  type LayeredMemoryItem,
  type LongTermMemoryCategory,
} from "@/app/lib/agent-runtime/memory-types";
import { getDatabase, now } from "./workspace-database";

interface LongTermMemoryRow {
  id: string;
  category: string;
  content: string;
  importance: number;
  access_count: number;
  created_at: string;
  updated_at: string;
  last_accessed_at: string | null;
}

export interface LongTermMemoryWriteInput {
  category: LongTermMemoryCategory;
  content: string;
  importance: number;
}

function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/gu, " ");
}

function contentHash(content: string): string {
  return createHash("sha256").update(normalizeContent(content)).digest("hex");
}

function isLongTermMemoryCategory(
  category: string,
): category is LongTermMemoryCategory {
  return [
    "preference",
    "constraint",
    "architecture",
    "decision",
    "lesson",
  ].includes(category);
}

function mapRow(row: LongTermMemoryRow): LayeredMemoryItem {
  return {
    id: row.id,
    layer: "long_term",
    category: isLongTermMemoryCategory(row.category)
      ? row.category
      : "lesson",
    content: row.content,
    importance: clampMemoryImportance(row.importance),
    accessCount: Math.max(0, row.access_count),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessedAt: row.last_accessed_at || undefined,
  };
}

/** 按重要性、访问频率和更新时间读取有限数量的长期记忆。 */
export function listLongTermMemories(
  projectId: string,
  limit = 160,
): LayeredMemoryItem[] {
  if (!projectId.trim()) return [];
  const safeLimit = Math.min(500, Math.max(1, Math.floor(limit)));
  const rows = getDatabase()
    .prepare(
      `SELECT id, category, content, importance, access_count,
              created_at, updated_at, last_accessed_at
       FROM agent_long_term_memory
       WHERE project_id = ?
       ORDER BY importance DESC, access_count DESC, updated_at DESC
       LIMIT ?`,
    )
    .all(projectId, safeLimit) as unknown as LongTermMemoryRow[];
  return rows.map(mapRow);
}

/**
 * 内容哈希相同的记忆会合并而不是重复插入。
 * 新一轮 Reflection 只能提高重要性，不会无意中降低已有经验的权重。
 */
export function upsertLongTermMemories(
  projectId: string,
  memories: readonly LongTermMemoryWriteInput[],
): LayeredMemoryItem[] {
  if (!projectId.trim() || !memories.length) return [];
  const db = getDatabase();
  const timestamp = now();
  const selectByHash = db.prepare(
    `SELECT id, category, content, importance, access_count,
            created_at, updated_at, last_accessed_at
     FROM agent_long_term_memory
     WHERE project_id = ? AND content_hash = ?`,
  );
  const insert = db.prepare(
    `INSERT INTO agent_long_term_memory (
       id, project_id, content_hash, category, content, importance,
       access_count, created_at, updated_at, last_accessed_at
     ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, NULL)`,
  );
  const update = db.prepare(
    `UPDATE agent_long_term_memory
     SET category = ?, content = ?, importance = ?, updated_at = ?
     WHERE id = ?`,
  );
  const result: LayeredMemoryItem[] = [];

  for (const memory of memories) {
    const content = normalizeContent(memory.content);
    if (!content) continue;
    const hash = contentHash(content);
    const existing = selectByHash.get(
      projectId,
      hash,
    ) as unknown as LongTermMemoryRow | undefined;
    const importance = clampMemoryImportance(memory.importance);

    if (existing) {
      update.run(
        memory.category,
        content,
        Math.max(importance, existing.importance),
        timestamp,
        existing.id,
      );
      result.push(
        mapRow({
          ...existing,
          category: memory.category,
          content,
          importance: Math.max(importance, existing.importance),
          updated_at: timestamp,
        }),
      );
      continue;
    }

    const id = randomUUID();
    insert.run(
      id,
      projectId,
      hash,
      memory.category,
      content,
      importance,
      timestamp,
      timestamp,
    );
    result.push(
      mapRow({
        id,
        category: memory.category,
        content,
        importance,
        access_count: 0,
        created_at: timestamp,
        updated_at: timestamp,
        last_accessed_at: null,
      }),
    );
  }

  return result;
}

/** 检索命中的长期记忆会增加访问次数，供后续 Memory Ranking 使用。 */
export function touchLongTermMemories(
  projectId: string,
  memoryIds: readonly string[],
): void {
  const ids = Array.from(new Set(memoryIds.filter(Boolean))).slice(0, 50);
  if (!projectId.trim() || !ids.length) return;
  const statement = getDatabase().prepare(
    `UPDATE agent_long_term_memory
     SET access_count = access_count + 1, last_accessed_at = ?
     WHERE project_id = ? AND id = ?`,
  );
  const timestamp = now();
  ids.forEach((id) => statement.run(timestamp, projectId, id));
}

/** 控制项目长期记忆规模，优先删除低价值且长期未访问的条目。 */
export function pruneLongTermMemories(
  projectId: string,
  maxEntries = 300,
): number {
  if (!projectId.trim()) return 0;
  const db = getDatabase();
  const safeLimit = Math.max(50, Math.floor(maxEntries));
  const countRow = db
    .prepare(
      "SELECT COUNT(*) AS total FROM agent_long_term_memory WHERE project_id = ?",
    )
    .get(projectId) as { total?: number } | undefined;
  const overflow = Math.max(0, Number(countRow?.total || 0) - safeLimit);
  if (!overflow) return 0;

  const rows = db
    .prepare(
      `SELECT id FROM agent_long_term_memory
       WHERE project_id = ?
       ORDER BY importance ASC, access_count ASC,
                COALESCE(last_accessed_at, created_at) ASC
       LIMIT ?`,
    )
    .all(projectId, overflow) as unknown as Array<{ id: string }>;
  const remove = db.prepare(
    "DELETE FROM agent_long_term_memory WHERE project_id = ? AND id = ?",
  );
  rows.forEach((row) => remove.run(projectId, row.id));
  return rows.length;
}
