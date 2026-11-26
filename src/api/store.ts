import { Database } from "bun:sqlite";
import type { SQLQueryBindings } from "bun:sqlite";
import { nowIso, toEpochMs } from "../shared/time";
import type { DeviceStatus, PushResponse, WireRow } from "../shared/types";
import { deleteWins, incomingWins } from "../shared/merge";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS memories (
  id            TEXT PRIMARY KEY,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
  updated_ms    INTEGER NOT NULL,
  last_accessed  TEXT,
  access_count  INTEGER NOT NULL DEFAULT 0,
  weight        REAL    NOT NULL DEFAULT 1.0,
  topic         TEXT    NOT NULL,
  summary       TEXT    NOT NULL,
  raw_excerpt   TEXT,
  keywords      TEXT    NOT NULL DEFAULT '[]',
  importance    TEXT    NOT NULL DEFAULT 'medium',
  source_type   TEXT,
  source_data   TEXT,
  related_ids   TEXT,
  summary_hash  TEXT,
  embedding     BLOB,
  origin_device TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_ms);
CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(topic);

-- Rows removed on any device. Kept so a re-used id cannot come back to life.
CREATE TABLE IF NOT EXISTS tombstones (
  id         TEXT PRIMARY KEY,
  updated_ms INTEGER NOT NULL,
  device_id  TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  device_id    TEXT PRIMARY KEY,
  last_push_ms INTEGER NOT NULL DEFAULT 0,
  last_pull_ms INTEGER NOT NULL DEFAULT 0,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL
);
`;

const UPSERT_SQL = `
INSERT INTO memories (
  id, created_at, updated_at, updated_ms, last_accessed, access_count, weight,
  topic, summary, raw_excerpt, keywords, importance, source_type, source_data,
  related_ids, summary_hash, embedding, origin_device
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  created_at    = excluded.created_at,
  updated_at    = excluded.updated_at,
  updated_ms    = excluded.updated_ms,
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
  embedding     = excluded.embedding,
  origin_device = excluded.origin_device
WHERE excluded.updated_ms > memories.updated_ms;
`;

const DELETE_SQL = `
DELETE FROM memories WHERE id = ? AND updated_ms <= ?;
`;

const UPSERT_TOMBSTONE_SQL = `
INSERT INTO tombstones (id, updated_ms, device_id, deleted_at)
VALUES (?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  updated_ms = excluded.updated_ms,
  device_id  = excluded.device_id,
  deleted_at = excluded.deleted_at
WHERE excluded.updated_ms > tombstones.updated_ms;
`;

function toDbRow(row: WireRow, updatedMs: number, deviceId: string): SQLQueryBindings[] {
  return [
    row.id,
    row.created_at,
    row.updated_at,
    updatedMs,
    row.last_accessed,
    row.access_count,
    row.weight,
    row.topic,
    row.summary,
    row.raw_excerpt,
    row.keywords,
    row.importance,
    row.source_type,
    row.source_data,
    row.related_ids,
    row.summary_hash,
    row.embedding_b64 ? Buffer.from(row.embedding_b64, "base64") : null,
    deviceId,
  ];
}

export class Store {
  private constructor(private db: Database) {}

  static open(path: string): Store {
    const db = new Database(path);
    db.exec(SCHEMA);
    return new Store(db);
  }

  /** Apply a batch of incoming rows and deletes. Returns what actually changed. */
  push(
    rows: WireRow[],
    deleted: { id: string; updated_ms: number }[],
    deviceId: string,
  ): PushResponse {
    const upsert = this.db.query(UPSERT_SQL);
    const remove = this.db.query(DELETE_SQL);
    const tombstone = this.db.query(UPSERT_TOMBSTONE_SQL);

    const run = this.db.transaction(() => {
      let inserted = 0;
      let updated = 0;
      let skipped = 0;

      for (const row of rows) {
        const updatedMs = toEpochMs(row.updated_at);
        const before = this.db
          .query("SELECT updated_ms FROM memories WHERE id = ?")
          .get(row.id) as { updated_ms: number } | null;

        if (!incomingWins(before?.updated_ms ?? null, updatedMs)) {
          skipped += 1;
          continue;
        }

        const result = upsert.run(...toDbRow(row, updatedMs, deviceId));
        if (before === null) {
          inserted += 1;
        } else {
          updated += result.changes > 0 ? 1 : 0;
        }

        // A newer row resurrects the id, so drop any older tombstone.
        this.db.query("DELETE FROM tombstones WHERE id = ? AND updated_ms < ?").run(
          row.id,
          updatedMs,
        );
      }

      let deletedCount = 0;
      for (const entry of deleted) {
        const existing = this.db
          .query("SELECT updated_ms FROM memories WHERE id = ?")
          .get(entry.id) as { updated_ms: number } | null;

        if (!deleteWins(existing?.updated_ms ?? null, entry.updated_ms)) {
          continue;
        }

        remove.run(entry.id, entry.updated_ms);
        tombstone.run(entry.id, entry.updated_ms, deviceId, nowIso());
        deletedCount += 1;
      }

      const stamp = nowIso();
      this.db
        .query(
          `INSERT INTO devices (device_id, last_push_ms, first_seen, last_seen)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(device_id) DO UPDATE SET
             last_push_ms = excluded.last_push_ms,
             last_seen    = excluded.last_seen`,
        )
        .run(deviceId, Date.now(), stamp, stamp);

      return {
        inserted,
        updated,
        skipped,
        deleted: deletedCount,
        server_rows: this.rowCount(),
      };
    });

    return run();
  }

  /** All live rows, oldest first, for a full snapshot pull. */
  *snapshot(): Generator<WireRow> {
    const iterator = this.db
      .query(
        `SELECT id, created_at, updated_at, last_accessed, access_count, weight,
                topic, summary, raw_excerpt, keywords, importance, source_type,
                source_data, related_ids, summary_hash, embedding
         FROM memories
         ORDER BY updated_ms ASC`,
      )
      .iterate();

    for (const row of iterator as Iterable<Record<string, unknown>>) {
      yield {
        id: row.id as string,
        created_at: row.created_at as string,
        updated_at: row.updated_at as string,
        last_accessed: (row.last_accessed as string | null) ?? null,
        access_count: (row.access_count as number) ?? 0,
        weight: (row.weight as number) ?? 1,
        topic: row.topic as string,
        summary: row.summary as string,
        raw_excerpt: (row.raw_excerpt as string | null) ?? null,
        keywords: (row.keywords as string) ?? "[]",
        importance: (row.importance as string) ?? "medium",
        source_type: (row.source_type as string | null) ?? null,
        source_data: (row.source_data as string | null) ?? null,
        related_ids: (row.related_ids as string) ?? "[]",
        summary_hash: (row.summary_hash as string | null) ?? null,
        embedding_b64: row.embedding
          ? Buffer.from(row.embedding as Uint8Array).toString("base64")
          : null,
      };
    }
  }

  rowCount(): number {
    return (this.db.query("SELECT COUNT(*) AS c FROM memories").get() as { c: number }).c;
  }

  tombstoneCount(): number {
    return (this.db.query("SELECT COUNT(*) AS c FROM tombstones").get() as { c: number }).c;
  }

  devices(): DeviceStatus[] {
    const rows = this.db
      .query(
        `SELECT device_id, last_push_ms, last_pull_ms, first_seen, last_seen
         FROM devices ORDER BY last_seen DESC`,
      )
      .all() as Record<string, unknown>[];
    return rows.map((row) => ({
      device_id: row.device_id as string,
      last_push_ms: row.last_push_ms as number,
      last_pull_ms: row.last_pull_ms as number,
      first_seen: row.first_seen as string,
      last_seen: row.last_seen as string,
    }));
  }

  touchPull(deviceId: string): void {
    const stamp = nowIso();
    this.db
      .query(
        `INSERT INTO devices (device_id, last_pull_ms, first_seen, last_seen)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           last_pull_ms = excluded.last_pull_ms,
           last_seen    = excluded.last_seen`,
      )
      .run(deviceId, Date.now(), stamp, stamp);
  }

  /** Consistent copy of the database for the backup timer. */
  backupTo(targetPath: string): void {
    this.db.query(`VACUUM INTO "${targetPath.replace(/"/g, '""')}"`).run();
  }
}
