import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
  TASKS,
  WRITES_IDX_MAP,
  copyCheckpoint,
  maxChannelVersion,
} from "@langchain/langgraph-checkpoint";

type CheckpointRow = {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id: string | null;
  type: string | null;
  checkpoint: Uint8Array | string;
  metadata: Uint8Array | string;
};

type WriteRow = {
  task_id: string;
  channel: string;
  type: string | null;
  value: Uint8Array | string | null;
};

type PendingSendRow = {
  type: string | null;
  value: Uint8Array | string | null;
};

type SqliteBindable = string | number | bigint | Uint8Array | null;

/*
 * `node:sqlite` 对绑定参数的类型要求比一些 ORM 更严格：
 * - 可以绑定 string / number / bigint / Uint8Array / null
 * - 但不能直接绑定 undefined
 *
 * LangGraph 这边有些字段在“首个 checkpoint”场景下会自然缺省，
 * 例如 parent checkpoint id，此时 JS 里通常是 undefined。
 * 如果不在落库前统一转成 null，就会出现：
 * `Provided value cannot be bound to SQLite parameter`
 *
 * 所以这里单独做一层最小归一化，把 SQLite 能理解的值留下，
 * 把 undefined 明确转成 null，避免每个 `.run()` 都手写同样的兜底逻辑。
 */
function toSqliteBindable(value: unknown): SqliteBindable {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  // 理论上 serde 后不应再落到这里；如果真的出现，转成字符串比直接抛到 SQLite 更可控。
  return JSON.stringify(value);
}

/*
 * 这里不用官方的 checkpoint-sqlite 包，而是直接基于 node:sqlite 做一个轻量实现。
 *
 * 原因不是功能不够，而是官方包内部依赖 better-sqlite3：
 * - 开发时没问题；
 * - 但 Electron 打包时会触发原生模块重编译；
 * - 当前机器没装 Python，就会被 node-gyp 卡住。
 *
 * 这个版本继续保留 SQLite 持久化能力，但去掉了 Electron 打包阶段最脆弱的原生依赖。
 */
class NodeSqliteSaver extends BaseCheckpointSaver {
  private readonly db: DatabaseSync;
  private isSetup = false;

  constructor(databasePath: string) {
    super();
    this.db = new DatabaseSync(databasePath);
  }

  private setup(): void {
    if (this.isSetup) return;

    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        type TEXT,
        checkpoint BLOB,
        metadata BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );

      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL DEFAULT '',
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        type TEXT,
        value BLOB,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
    `);

    this.isSetup = true;
  }

  private readPendingWrites(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): WriteRow[] {
    return this.db
      .prepare(`
        SELECT task_id, channel, type, value
        FROM writes
        WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
        ORDER BY idx ASC
      `)
      .all(threadId, checkpointNs, checkpointId) as unknown as WriteRow[];
  }

  private readPendingSends(
    threadId: string,
    checkpointNs: string,
    checkpointId: string,
  ): PendingSendRow[] {
    return this.db
      .prepare(`
        SELECT type, value
        FROM writes
        WHERE thread_id = ?
          AND checkpoint_ns = ?
          AND checkpoint_id = ?
          AND channel = ?
        ORDER BY idx ASC
      `)
      .all(threadId, checkpointNs, checkpointId, TASKS) as unknown as PendingSendRow[];
  }

  private async buildCheckpointTuple(
    row: CheckpointRow,
    checkpointNs: string,
  ): Promise<CheckpointTuple> {
    const pendingWrites = await Promise.all(
      this.readPendingWrites(row.thread_id, checkpointNs, row.checkpoint_id).map(
        async (write) =>
          [
            write.task_id,
            write.channel,
            await this.serde.loadsTyped(write.type ?? "json", write.value ?? ""),
          ] as [string, string, unknown],
      ),
    );

    const checkpoint = await this.serde.loadsTyped(
      row.type ?? "json",
      row.checkpoint,
    );

    if (checkpoint.v < 4 && row.parent_checkpoint_id) {
      await this.migratePendingSends(
        checkpoint,
        row.thread_id,
        checkpointNs,
        row.parent_checkpoint_id,
      );
    }

    return {
      config: {
        configurable: {
          thread_id: row.thread_id,
          checkpoint_ns: checkpointNs,
          checkpoint_id: row.checkpoint_id,
        },
      },
      checkpoint,
      metadata: await this.serde.loadsTyped(row.type ?? "json", row.metadata),
      parentConfig: row.parent_checkpoint_id
        ? {
            configurable: {
              thread_id: row.thread_id,
              checkpoint_ns: checkpointNs,
              checkpoint_id: row.parent_checkpoint_id,
            },
          }
        : undefined,
      pendingWrites,
    };
  }

  async getTuple(
    config: RunnableConfig,
  ): Promise<CheckpointTuple | undefined> {
    this.setup();

    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = config.configurable?.checkpoint_id;

    if (!threadId) return undefined;

    const row = checkpointId
      ? (this.db
          .prepare(`
            SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
            FROM checkpoints
            WHERE thread_id = ? AND checkpoint_ns = ? AND checkpoint_id = ?
          `)
          .get(
            threadId,
            checkpointNs,
            checkpointId,
          ) as unknown as CheckpointRow | undefined)
      : (this.db
          .prepare(`
            SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
            FROM checkpoints
            WHERE thread_id = ? AND checkpoint_ns = ?
            ORDER BY checkpoint_id DESC
            LIMIT 1
          `)
          .get(threadId, checkpointNs) as unknown as CheckpointRow | undefined);

    if (!row) return undefined;

    return this.buildCheckpointTuple(row, checkpointNs);
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    this.setup();

    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns;
    const beforeCheckpointId = options?.before?.configurable?.checkpoint_id;
    const limit = options?.limit;
    const filter = options?.filter ?? {};

    const clauses: string[] = [];
    const args: Array<string | number> = [];

    if (threadId) {
      clauses.push("thread_id = ?");
      args.push(threadId);
    }
    if (checkpointNs !== undefined && checkpointNs !== null) {
      clauses.push("checkpoint_ns = ?");
      args.push(checkpointNs);
    }
    if (beforeCheckpointId) {
      clauses.push("checkpoint_id < ?");
      args.push(beforeCheckpointId);
    }

    const whereClause = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`
        SELECT thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata
        FROM checkpoints
        ${whereClause}
        ORDER BY checkpoint_id DESC
      `)
      .all(...args) as unknown as CheckpointRow[];

    let yielded = 0;
    for (const row of rows) {
      const tuple = await this.buildCheckpointTuple(
        row,
        row.checkpoint_ns ?? "",
      );

      const metadata = (tuple.metadata ?? {}) as Record<string, unknown>;
      const matchesFilter = Object.entries(filter).every(
        ([key, value]) => metadata[key] === value,
      );
      if (!matchesFilter) continue;

      yield tuple;
      yielded += 1;

      if (limit && yielded >= limit) return;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    // LangGraph 当前会把 newVersions 也传进来，但这个 SQLite 实现不需要单独落它。
    _newVersions: Record<string, string | number>,
  ): Promise<RunnableConfig> {
    this.setup();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }

    const threadId = config.configurable.thread_id;
    const checkpointNs = config.configurable.checkpoint_ns ?? "";
    const parentCheckpointId = config.configurable.checkpoint_id;

    if (!threadId) {
      throw new Error('Missing "thread_id" field in passed "config.configurable".');
    }

    const preparedCheckpoint = copyCheckpoint(checkpoint);
    const [[checkpointType, serializedCheckpoint], [metadataType, serializedMetadata]] =
      await Promise.all([
        this.serde.dumpsTyped(preparedCheckpoint),
        this.serde.dumpsTyped(metadata),
      ]);

    if (checkpointType !== metadataType) {
      throw new Error("Failed to serialize checkpoint and metadata to the same type.");
    }

    this.db
      .prepare(`
        INSERT OR REPLACE INTO checkpoints
        (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        toSqliteBindable(threadId),
        toSqliteBindable(checkpointNs),
        toSqliteBindable(checkpoint.id),
        toSqliteBindable(parentCheckpointId),
        toSqliteBindable(checkpointType),
        toSqliteBindable(serializedCheckpoint),
        toSqliteBindable(serializedMetadata),
      );

    return {
      configurable: {
        thread_id: threadId,
        checkpoint_ns: checkpointNs,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    this.setup();

    if (!config.configurable) {
      throw new Error("Empty configuration supplied.");
    }
    if (!config.configurable.thread_id) {
      throw new Error("Missing thread_id field in config.configurable.");
    }
    if (!config.configurable.checkpoint_id) {
      throw new Error("Missing checkpoint_id field in config.configurable.");
    }

    const allSpecial = writes.every(([channel]) => channel in WRITES_IDX_MAP);
    const insertMode = allSpecial ? "OR REPLACE" : "OR IGNORE";
    const threadId = config.configurable.thread_id;
    const checkpointNs = config.configurable.checkpoint_ns ?? "";
    const checkpointId = config.configurable.checkpoint_id;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (let index = 0; index < writes.length; index += 1) {
        const write = writes[index];
        const [type, serializedWrite] = await this.serde.dumpsTyped(write[1]);

        this.db
          .prepare(`
            INSERT ${insertMode} INTO writes
            (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, type, value)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            toSqliteBindable(threadId),
            toSqliteBindable(checkpointNs),
            toSqliteBindable(checkpointId),
            toSqliteBindable(taskId),
            toSqliteBindable(WRITES_IDX_MAP[write[0]] ?? index),
            toSqliteBindable(write[0]),
            toSqliteBindable(type),
            toSqliteBindable(serializedWrite),
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    this.setup();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("DELETE FROM checkpoints WHERE thread_id = ?")
        .run(threadId);
      this.db.prepare("DELETE FROM writes WHERE thread_id = ?").run(threadId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private async migratePendingSends(
    checkpoint: Checkpoint,
    threadId: string,
    checkpointNs: string,
    parentCheckpointId: string,
  ): Promise<void> {
    const pendingSends = this.readPendingSends(
      threadId,
      checkpointNs,
      parentCheckpointId,
    );

    const mutableCheckpoint = checkpoint;
    mutableCheckpoint.channel_values ??= {};
    mutableCheckpoint.channel_values[TASKS] = await Promise.all(
      pendingSends.map((item) =>
        this.serde.loadsTyped(item.type ?? "json", item.value ?? ""),
      ),
    );
    mutableCheckpoint.channel_versions[TASKS] =
      Object.keys(checkpoint.channel_versions).length > 0
        ? maxChannelVersion(...Object.values(checkpoint.channel_versions))
        : this.getNextVersion(undefined);
  }
}

// Checkpointer 进程内做单例缓存，避免每次 import 都重复打开 SQLite 连接。
let checkpointer: NodeSqliteSaver | undefined;

function getAgentDataDir(): string {
  const dataDir =
    process.env.AGENT_DATA_DIR || path.join(process.cwd(), ".agent-data");
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export function getLangGraphCheckpointer(): BaseCheckpointSaver {
  if (checkpointer) return checkpointer;

  // LangGraph 的短期线程状态单独存一份 SQLite，和 workspace 数据分库保存。
  const sqlitePath = path.join(
    getAgentDataDir(),
    "langgraph-checkpoints.sqlite",
  );
  checkpointer = new NodeSqliteSaver(sqlitePath);
  return checkpointer;
}
