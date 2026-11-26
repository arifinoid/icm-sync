/**
 * Conflict rules for the sync protocol.
 *
 * Every row carries the `updated_ms` of its last content edit, so a push is a
 * plain last-write-wins per row id. Deletes are guarded by the `updated_ms` the
 * device last saw, which stops an out-of-date device from wiping a row that was
 * edited on another machine after the delete was issued.
 */

/** An incoming row wins only when it is strictly newer than what is stored. */
export function incomingWins(
  storedUpdatedMs: number | null,
  incomingUpdatedMs: number,
): boolean {
  return storedUpdatedMs === null || incomingUpdatedMs > storedUpdatedMs;
}

/** A delete wins only when the stored row is not newer than the delete marker. */
export function deleteWins(
  storedUpdatedMs: number | null,
  deleteUpdatedMs: number,
): boolean {
  // A row the server has never seen (null) is trivially deleted.
  return storedUpdatedMs === null || storedUpdatedMs <= deleteUpdatedMs;
}

export interface ApplyPlan {
  /** Rows that should be written to the store. */
  apply: string[];
  /** Incoming rows rejected because the stored row is newer or equally new. */
  skipped: string[];
}

/** Pure helper used by tests and by the store to describe a push. */
export function planRowUpdates(
  stored: Map<string, number>,
  incoming: { id: string; updated_ms: number }[],
): ApplyPlan {
  const apply: string[] = [];
  const skipped: string[] = [];
  for (const row of incoming) {
    if (incomingWins(stored.get(row.id) ?? null, row.updated_ms)) {
      apply.push(row.id);
    } else {
      skipped.push(row.id);
    }
  }
  return { apply, skipped };
}
