import { openSync, closeSync, unlinkSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { SyncError, runSync } from "./client";
import { loadState } from "./state";
import { LocalDb } from "./localdb";

export interface CliConfig {
  url: string;
  token: string;
  deviceId: string;
  dbPath: string;
  statePath: string;
  batch: number;
}

export function configFromEnv(): CliConfig {
  const required = (name: string): string => {
    const value = process.env[name];
    if (!value) throw new Error(`missing required environment variable: ${name}`);
    return value;
  };

  const dataDir = `${homedir()}/.local/share/icm`;

  return {
    url: required("ICM_SYNC_URL"),
    token: process.env.ICM_SYNC_TOKEN ?? "",
    deviceId: required("ICM_SYNC_DEVICE"),
    dbPath: process.env.ICM_DB ?? `${dataDir}/memories.db`,
    statePath: process.env.ICM_SYNC_STATE ?? `${dataDir}/sync-state.json`,
    batch: Number(process.env.ICM_SYNC_BATCH ?? 200),
  };
}

/**
 * Cross-process guard so a timer run and a manual run cannot replace the local
 * database at the same time. Stale locks older than ten minutes are taken over.
 */
function acquireLock(path: string): () => void {
  const staleAfter = 10 * 60 * 1000;
  try {
    const existing = statSync(path);
    if (Date.now() - existing.mtimeMs > staleAfter) {
      unlinkSync(path);
    }
  } catch {
    // No lock file yet.
  }

  let handle: number;
  try {
    handle = openSync(path, "wx");
  } catch {
    throw new SyncError(`another sync is already running (${path})`);
  }
  closeSync(handle);
  return () => {
    try {
      unlinkSync(path);
    } catch {
      // Already gone.
    }
  };
}

function printResult(result: Awaited<ReturnType<typeof runSync>>): void {
  console.log(
    [
      `pushed=${result.pushed} (inserted=${result.inserted} updated=${result.updated} skipped=${result.skipped})`,
      `deleted=${result.pushedDeletes}`,
      `pulled=${result.pulled} applied=${result.applied} removed=${result.deleted}`,
      `server_rows=${result.serverRows}`,
    ].join(" "),
  );
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "sync";
  const config = configFromEnv();

  if (command === "status") {
    const state = loadState(config.statePath, config.deviceId);
    const local = LocalDb.open(config.dbPath);
    console.log(
      JSON.stringify(
        {
          device_id: config.deviceId,
          url: config.url,
          db_path: config.dbPath,
          local_rows: local.count(),
          last_push_ms: state.last_push_ms,
          last_pull_ms: state.last_pull_ms,
          known_rows: Object.keys(state.known).length,
        },
        null,
        2,
      ),
    );
    local.close();
    return;
  }

  const release = acquireLock(`${config.statePath}.lock`);
  try {
    const result = await runSync(
      {
        ...config,
        full: command === "full",
        log: (message) => console.error(message),
      },
    );
    printResult(result);
  } finally {
    release();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
