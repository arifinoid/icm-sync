import type { MemoryRow, WireRow } from "./types";

/** Convert a local ICM row into the JSON wire form (embedding as base64). */
export function toWire(row: MemoryRow): WireRow {
  return {
    id: row.id,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
    last_accessed: row.lastAccessed,
    access_count: row.accessCount,
    weight: row.weight,
    topic: row.topic,
    summary: row.summary,
    raw_excerpt: row.rawExcerpt,
    keywords: row.keywords,
    importance: row.importance,
    source_type: row.sourceType,
    source_data: row.sourceData,
    related_ids: row.relatedIds,
    summary_hash: row.summaryHash,
    embedding_b64: row.embedding ? Buffer.from(row.embedding).toString("base64") : null,
  };
}

/** Convert a wire row back into the local ICM row shape. */
export function fromWire(row: WireRow): MemoryRow {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAccessed: row.last_accessed,
    accessCount: row.access_count,
    weight: row.weight,
    topic: row.topic,
    summary: row.summary,
    rawExcerpt: row.raw_excerpt,
    keywords: row.keywords,
    importance: row.importance,
    sourceType: row.source_type,
    sourceData: row.source_data,
    relatedIds: row.related_ids,
    summaryHash: row.summary_hash,
    embedding: row.embedding_b64 ? Buffer.from(row.embedding_b64, "base64") : null,
  };
}

/**
 * Parse a pushed request body into wire rows, throwing on malformed input.
 * Unknown extra fields are ignored so the client and server can drift slightly.
 */
export function parsePushRequest(body: unknown): {
  deviceId: string;
  rows: WireRow[];
  deleted: { id: string; updated_ms: number }[];
} {
  if (typeof body !== "object" || body === null) {
    throw new Error("request body must be a JSON object");
  }
  const input = body as Record<string, unknown>;

  if (typeof input.device_id !== "string" || input.device_id.length === 0) {
    throw new Error("device_id must be a non-empty string");
  }
  if (!Array.isArray(input.rows)) {
    throw new Error("rows must be an array");
  }
  if (!Array.isArray(input.deleted)) {
    throw new Error("deleted must be an array");
  }

  const rows = input.rows.map((value, index) => {
    const row = value as Record<string, unknown>;
    for (const field of ["id", "created_at", "updated_at", "topic", "summary"]) {
      if (typeof row[field] !== "string") {
        throw new Error(`rows[${index}].${field} must be a string`);
      }
    }
    return {
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
      embedding_b64: (row.embedding_b64 as string | null) ?? null,
    } satisfies WireRow;
  });

  const deleted = input.deleted.map((value, index) => {
    const entry = value as Record<string, unknown>;
    if (typeof entry.id !== "string" || typeof entry.updated_ms !== "number") {
      throw new Error(`deleted[${index}] must have string id and numeric updated_ms`);
    }
    return { id: entry.id, updated_ms: entry.updated_ms };
  });

  return { deviceId: input.device_id, rows, deleted };
}
