import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryRow } from "../../src/shared/types";

/**
 * The real ICM schema (FTS5 + sqlite-vec) cannot be rebuilt without ICM's own
 * binary, so tests use the column subset the sync client actually reads and
 * writes. That is the same contract the client relies on.
 */
const LOCAL_SCHEMA = `
CREATE TABLE memories (
  id            TEXT PRIMARY KEY,
  created_at    TEXT    NOT NULL,
  updated_at    TEXT    NOT NULL,
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
  embedding     BLOB
);
`;

export function makeRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
  const id = overrides.id ?? `01M${Math.random().toString(36).slice(2, 12).toUpperCase()}`;
  const stamp = overrides.updatedAt ?? "2026-10-25T11:59:31.018058989+00:00";
  return {
    id,
    createdAt: stamp,
    updatedAt: stamp,
    lastAccessed: stamp,
    accessCount: 0,
    weight: 1,
    topic: "context-test",
    summary: `summary for ${id}`,
    rawExcerpt: null,
    keywords: "[]",
    importance: "medium",
    sourceType: "manual",
    sourceData: null,
    relatedIds: "[]",
    summaryHash: `hash-${id}`,
    embedding: null,
    ...overrides,
  };
}

export function makeLocalDb(path: string, rows: MemoryRow[] = []): void {
  const db = new Database(path);
  db.exec(LOCAL_SCHEMA);
  const insert = db.query(
    `INSERT INTO memories (
       id, created_at, updated_at, last_accessed, access_count, weight, topic, summary,
       raw_excerpt, keywords, importance, source_type, source_data, related_ids,
       summary_hash, embedding
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      ...([
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
      ] satisfies [string, string, string, string | null, number, number, string, string, string | null, string, string, string | null, string | null, string, string | null, Uint8Array | null]),
    );
  }
  db.close();
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
