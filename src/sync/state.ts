import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";

export interface SyncState {
  version: 1;
  device_id: string;
  /** Highest `updated_ms` this device has pushed. */
  last_push_ms: number;
  last_pull_ms: number;
  /** Last `updated_ms` seen per row id, used to detect local deletes. */
  known: Record<string, number>;
}

export function defaultState(deviceId: string): SyncState {
  return { version: 1, device_id: deviceId, last_push_ms: 0, last_pull_ms: 0, known: {} };
}

export function loadState(path: string, deviceId: string): SyncState {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<SyncState>;
    if (raw.version !== 1 || raw.device_id !== deviceId) {
      return defaultState(deviceId);
    }
    return {
      version: 1,
      device_id: deviceId,
      last_push_ms: typeof raw.last_push_ms === "number" ? raw.last_push_ms : 0,
      last_pull_ms: typeof raw.last_pull_ms === "number" ? raw.last_pull_ms : 0,
      known: typeof raw.known === "object" && raw.known !== null ? (raw.known as Record<string, number>) : {},
    };
  } catch {
    return defaultState(deviceId);
  }
}

/** Write atomically so an interrupted sync cannot leave a truncated state file. */
export function saveState(path: string, state: SyncState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2));
  renameSync(temporary, path);
}
