import { LocalDb } from "./localdb";
import { defaultState, loadState, saveState } from "./state";
import type { DeletedId, MemoryRow, PushResponse, WireRow } from "../shared/types";
import { fromWire, toWire } from "../shared/wire";

export interface SyncConfig {
  url: string;
  token: string;
  deviceId: string;
  dbPath: string;
  statePath: string;
  /** Rows per push request. */
  batch: number;
  /** Ignore the cursor and push every local row. */
  full: boolean;
  log: (message: string) => void;
}

export interface SyncResult {
  pushed: number;
  inserted: number;
  updated: number;
  skipped: number;
  pushedDeletes: number;
  pulled: number;
  applied: number;
  deleted: number;
  serverRows: number;
}

export class SyncError extends Error {}

function authHeaders(token: string): Record<string, string> {
  return token.length > 0 ? { Authorization: `Bearer ${token}` } : {};
}

async function pushBatch(
  config: SyncConfig,
  rows: WireRow[],
  deleted: DeletedId[],
  fetchImpl: typeof fetch,
): Promise<PushResponse> {
  const response = await fetchImpl(`${config.url.replace(/\/$/, "")}/v1/push`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders(config.token) },
    body: JSON.stringify({ device_id: config.deviceId, rows, deleted }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new SyncError(`push failed: HTTP ${response.status} ${body}`.trim());
  }

  return (await response.json()) as PushResponse;
}

async function pullSnapshot(
  config: SyncConfig,
  fetchImpl: typeof fetch,
): Promise<MemoryRow[]> {
  const response = await fetchImpl(
    `${config.url.replace(/\/$/, "")}/v1/snapshot?device_id=${encodeURIComponent(config.deviceId)}`,
    { headers: authHeaders(config.token), signal: AbortSignal.timeout(300_000) },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new SyncError(`snapshot failed: HTTP ${response.status} ${body}`.trim());
  }

  const text = await response.text();
  const rows: MemoryRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    rows.push(fromWire(JSON.parse(line) as WireRow));
  }
  return rows;
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

/**
 * One sync round: push local changes, then pull the canonical snapshot and make
 * the local ICM database match it.
 *
 * The pull is skipped when the push fails, so a reachable-but-broken server can
 * never make a device delete its own memories.
 */
export async function runSync(
  config: SyncConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<SyncResult> {
  const state = loadState(config.statePath, config.deviceId);
  const local = LocalDb.open(config.dbPath);
  const localRows = local.rows();
  const localIds = new Set(localRows.map((entry) => entry.row.id));

  // Rows deleted locally since the previous round: known ids that are gone now.
  const deleted: DeletedId[] = Object.entries(state.known)
    .filter(([id]) => !localIds.has(id))
    .map(([id, updatedMs]) => ({ id, updated_ms: updatedMs }));

  const pending = config.full
    ? localRows
    : localRows.filter((entry) => entry.updatedMs > state.last_push_ms);

  const wireRows = pending.map((entry) => toWire(entry.row));

  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  let deletedCount = 0;
  let serverRows = 0;

  const batches = chunk(wireRows, config.batch);
  // Always talk to the server once so its row count is known, even when this
  // device has nothing new to send.
  if (batches.length === 0) batches.push([]);
  for (const batch of batches) {
    const result = await pushBatch(config, batch, deleted, fetchImpl);
    inserted += result.inserted;
    updated += result.updated;
    skipped += result.skipped;
    deletedCount += result.deleted;
    serverRows = result.server_rows;
  }

  // A device that has never pushed (or a freshly reset server) must send
  // everything, otherwise the snapshot would look empty and wipe the device.
  if (serverRows === 0 && localRows.length > 0 && wireRows.length === 0) {
    config.log("server has no rows, performing a full push");
    for (const batch of chunk(localRows.map((entry) => toWire(entry.row)), config.batch)) {
      const result = await pushBatch(config, batch, deleted, fetchImpl);
      inserted += result.inserted;
      updated += result.updated;
      skipped += result.skipped;
      deletedCount += result.deleted;
      serverRows = result.server_rows;
    }
  }

  if (serverRows === 0 && localRows.length > 0) {
    throw new SyncError(
      "server reports zero rows after a full push; refusing to pull an empty snapshot",
    );
  }

  const snapshot = await pullSnapshot(config, fetchImpl);
  const applied = local.applySnapshot(snapshot);

  // The cursor is the newest row timestamp we read, not the wall clock, so a
  // row edited while this round was running is still pushed next time.
  const newestLocal = localRows.reduce((max, entry) => Math.max(max, entry.updatedMs), 0);

  const next = defaultState(config.deviceId);
  next.last_push_ms = Math.max(state.last_push_ms, newestLocal);
  next.last_pull_ms = Date.now();
  for (const row of snapshot) {
    next.known[row.id] = Date.parse(row.updatedAt);
  }
  saveState(config.statePath, next);
  local.close();

  return {
    pushed: wireRows.length,
    inserted,
    updated,
    skipped,
    pushedDeletes: deletedCount,
    pulled: snapshot.length,
    applied: applied.applied,
    deleted: applied.deleted,
    serverRows,
  };
}
