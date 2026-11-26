/**
 * Timestamp helpers.
 *
 * ICM stores timestamps as ISO-8601 strings with nanosecond precision and a
 * `+00:00` offset (for example `2026-10-25T11:59:31.018058989+00:00`). JavaScript
 * dates only resolve to milliseconds, which is fine here: last-write-wins only
 * has to order edits made on different machines, and a tie is resolved by
 * keeping the row that is already stored.
 */

export function toEpochMs(iso: string): number {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid ISO-8601 timestamp: ${iso}`);
  }
  return ms;
}

/** Current wall clock in milliseconds. */
export function nowMs(): number {
  return Date.now();
}

/** Current wall clock as an ISO string, for server audit columns. */
export function nowIso(): string {
  return new Date().toISOString();
}
