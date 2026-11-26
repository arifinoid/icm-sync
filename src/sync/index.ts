import { openSync, closeSync, unlinkSync, statSync, readFileSync } from "node:fs";
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

/** Read `KEY=value` lines, skipping comments and blanks. */
function readEnvFile(path: string): Map<string, string> {
  const values = new Map<string, string>();
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    // No file yet (fresh machine, or the unit has not run) — nothing to merge.
    return values;
  }
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
  }
  return values;
}

export function configFromEnv(): CliConfig {
  // The Nix module writes this file and the systemd unit loads it through
  // EnvironmentFile, which a manual `icm-sync full` does not have. Reading it
  // here keeps both invocation paths identical.
  const fileValues = readEnvFile(
    process.env.ICM_SYNC_ENV_FILE ?? `${homedir()}/.config/icm-sync/env`,
  );
  const lookup = (name: string): string | undefined =>
    process.env[name] ?? fileValues.get(name);
  const required = (name: string): string => {
    const value = lookup(name);
    if (!value) throw new Error(`missing required environment variable: ${name}`);
    return value;
  };

  const dataDir = `${homedir()}/.local/share/icm`;

  return {
    url: required("ICM_SYNC_URL"),
    token: lookup("ICM_SYNC_TOKEN") ?? "",
    deviceId: required("ICM_SYNC_DEVICE"),
    dbPath: lookup("ICM_DB") ?? `${dataDir}/memories.db`,
    statePath: lookup("ICM_SYNC_STATE") ?? `${dataDir}/sync-state.json`,
    batch: Number(lookup("ICM_SYNC_BATCH") ?? 200),
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
