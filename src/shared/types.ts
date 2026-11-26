/**
 * Shared types for the ICM sync protocol.
 *
 * A `MemoryRow` mirrors one row of ICM's local `memories` table. The wire form
 * is used for JSON transport: the embedding blob becomes base64 and column
 * names keep their snake_case spelling so the server schema stays obvious.
 */

export interface MemoryRow {
  id: string;
  createdAt: string;
  updatedAt: string;
  lastAccessed: string | null;
  accessCount: number;
  weight: number;
  topic: string;
  summary: string;
  rawExcerpt: string | null;
  /** JSON array string, stored verbatim by ICM. */
  keywords: string;
  importance: string;
  sourceType: string | null;
  sourceData: string | null;
  /** JSON array string, stored verbatim by ICM. */
  relatedIds: string;
  summaryHash: string | null;
  /** Raw little-endian float32 vector, or null when ICM has no embedding. */
  embedding: Uint8Array | null;
}

export interface WireRow {
  id: string;
  created_at: string;
  updated_at: string;
  last_accessed: string | null;
  access_count: number;
  weight: number;
  topic: string;
  summary: string;
  raw_excerpt: string | null;
  keywords: string;
  importance: string;
  source_type: string | null;
  source_data: string | null;
  related_ids: string;
  summary_hash: string | null;
  embedding_b64: string | null;
}

export interface PushRequest {
  device_id: string;
  rows: WireRow[];
  deleted: DeletedId[];
}

export interface DeletedId {
  id: string;
  /**
   * `updated_ms` of the row as the device last knew it. The server only deletes
   * a row that is not newer than this marker, so a stale delete cannot wipe a
   * concurrent edit.
   */
  updated_ms: number;
}

export interface PushResponse {
  inserted: number;
  updated: number;
  skipped: number;
  deleted: number;
  server_rows: number;
}

export interface DeviceStatus {
  device_id: string;
  last_push_ms: number;
  last_pull_ms: number;
  first_seen: string;
  last_seen: string;
}

export interface StatusResponse {
  rows: number;
  tombstones: number;
  devices: DeviceStatus[];
}
