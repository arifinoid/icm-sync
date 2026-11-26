import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import type { MemoryRow } from "../shared/types";

const COLUMNS = `
  id, created_at, updated_at, last_accessed, access_count, weight, topic, summary,
  raw_excerpt, keywords, importance, source_type, source_data, related_ids,
  summary_hash, embedding
`;

const UPSERT_SQL = `
INSERT INTO memories (
  id, created_at, updated_at, last_accessed, access_count, weight, topic, summary,
  raw_excerpt, keywords, importance, source_type, source_data, related_ids,
  summary_hash, embedding
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  created_at    = excluded.created_at,
  updated_at    = excluded.updated_at,
  last_accessed = excluded.last_accessed,
  access_count  = excluded.access_count,
  weight        = excluded.weight,
  topic         = excluded.topic,
  summary       = excluded.summary,
  raw_excerpt   = excluded.raw_excerpt,
  keywords      = excluded.keywords,
  importance    = excluded.importance,
  source_type   = excluded.source_type,
  source_data   = excluded.source_data,
  related_ids   = excluded.related_ids,
  summary_hash  = excluded.summary_hash,
  embedding     = excluded.embedding;
`;

export interface LocalRow {
  row: MemoryRow;
  updatedMs: number;
}

function readRows(db: Database): LocalRow[] {
  const statement = db.query(`SELECT ${COLUMNS} FROM memories`);
  const rows: LocalRow[] = [];
  for (const raw of statement.iterate() as Iterable<Record<string, unknown>>) {
    const row: MemoryRow = {
      id: raw.id as string,
      createdAt: raw.created_at as string,
      updatedAt: raw.updated_at as string,
      lastAccessed: (raw.last_accessed as string | null) ?? null,
      accessCount: (raw.access_count as number) ?? 0,
      weight: (raw.weight as number) ?? 1,
      topic: raw.topic as string,
      summary: raw.summary as string,
      rawExcerpt: (raw.raw_excerpt as string | null) ?? null,
      keywords: (raw.keywords as string) ?? "[]",
      importance: (raw.importance as string) ?? "medium",
      sourceType: (raw.source_type as string | null) ?? null,
      sourceData: (raw.source_data as string | null) ?? null,
      relatedIds: (raw.related_ids as string) ?? "[]",
      summaryHash: (raw.summary_hash as string | null) ?? null,
      embedding: (raw.embedding as Uint8Array | null) ?? null,
    };
    rows.push({ row, updatedMs: Date.parse(row.updatedAt) });
  }
  return rows;
}

/**
 * Keep a single row per `summary_hash`, preferring the newest. The server has no
 * unique constraint there (it accepts a row from every device), but the local
 * ICM database does, so a snapshot holding two ids for one hash cannot be
 * applied as-is. Ties keep the first row, which makes the choice deterministic
 * for every device because the snapshot is ordered by `updated_ms`.
 */
function dedupeBySummaryHash(rows: MemoryRow[]): MemoryRow[] {
  const winnerByHash = new Map<string, MemoryRow>();
  for (const row of rows) {
    if (row.summaryHash === null) continue;
    const current = winnerByHash.get(row.summaryHash);
    if (current === undefined || row.updatedAt > current.updatedAt) {
      winnerByHash.set(row.summaryHash, row);
    }
  }

  return rows.filter(
    (row) => row.summaryHash === null || winnerByHash.get(row.summaryHash) === row,
  );
}

export class LocalDb {
  private constructor(private db: Database) {}

  static open(path: string): LocalDb {
    const db = new Database(path);
    db.exec("PRAGMA busy_timeout = 5000;");
    return new LocalDb(db);
  }

  /** All rows currently in the local ICM database. */
  rows(): LocalRow[] {
    return readRows(this.db);
  }

  count(): number {
    return (this.db.query("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Replace the local memories with the pushed snapshot: upsert everything the
   * server has, then drop local rows the server no longer knows about.
   *
   * Rows are upserted rather than deleting the table first so the FTS triggers
   * stay correct and a crash mid-transaction cannot leave an empty database.
   * The `vec_memories` virtual table belongs to the ICM binary's sqlite-vec
   * extension, which is not loadable here, so it is intentionally left alone.
   */
  applySnapshot(rows: MemoryRow[]): { applied: number; deleted: number } {
    const upsert = this.db.query(UPSERT_SQL);
    const dropTwin = this.db.query("DELETE FROM memories WHERE summary_hash = ? AND id <> ?");
    const remoteIds = new Set<string>();

    const run = this.db.transaction(() => {
      let applied = 0;
      for (const row of dedupeBySummaryHash(rows)) {
        remoteIds.add(row.id);
        // ICM's schema puts a UNIQUE index on summary_hash, so one
        // topic + summary cannot exist twice in a database. Two devices can
        // still record that memory independently under different ids; the
        // snapshot is canonical, so the local twin gives way to it.
        if (row.summaryHash !== null) {
          dropTwin.run(row.summaryHash, row.id);
        }
        const bindings: SQLQueryBindings[] = [
          row.id,
          row.createdAt,
          row.updatedAt,
          row.lastAccessed,
          row.accessCount,
          row.weight,
          row.topic,
          row.summary,
          row.rawExcerpt,
          row.keywords,
          row.importance,
          row.sourceType,
          row.sourceData,
          row.relatedIds,
          row.summaryHash,
          row.embedding,
        ];
        upsert.run(...bindings);
        applied += 1;
      }

      let deleted = 0;
      for (const local of readRows(this.db)) {
        if (!remoteIds.has(local.row.id)) {
          this.db.query("DELETE FROM memories WHERE id = ?").run(local.row.id);
          deleted += 1;
        }
      }
      return { applied, deleted };
    });

    return run();
  }
}
