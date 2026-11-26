import { Hono } from "hono";
import { timingSafeEqual } from "node:crypto";
import { Store } from "./store";
import { parsePushRequest } from "../shared/wire";
import type { StatusResponse } from "../shared/types";

export interface ApiOptions {
  store: Store;
  /** Shared bearer token. Empty string disables auth (development only). */
  token: string;
}

function authorized(token: string, header: string | undefined): boolean {
  if (token.length === 0) return true;
  if (!header || !header.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Build the Hono app. Exported so tests can drive it with `app.request()`. */
export function createApp({ store, token }: ApiOptions): Hono {
  const app = new Hono();

  app.get("/healthz", (c) => {
    return c.json({ ok: true, rows: store.rowCount(), tombstones: store.tombstoneCount() });
  });

  app.use("/v1/*", async (c, next) => {
    if (!authorized(token, c.req.header("Authorization"))) {
      return c.text("unauthorized", 401);
    }
    await next();
  });

  app.get("/v1/status", (c) => {
    const body: StatusResponse = {
      rows: store.rowCount(),
      tombstones: store.tombstoneCount(),
      devices: store.devices(),
    };
    return c.json(body);
  });

  app.post("/v1/push", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.text("invalid JSON body", 400);
    }

    let parsed;
    try {
      parsed = parsePushRequest(body);
    } catch (error) {
      return c.text((error as Error).message, 400);
    }

    const result = store.push(parsed.rows, parsed.deleted, parsed.deviceId);
    return c.json(result);
  });

  app.get("/v1/snapshot", (c) => {
    const deviceId = c.req.query("device_id");
    if (deviceId) store.touchPull(deviceId);

    const lines: string[] = [];
    for (const row of store.snapshot()) {
      lines.push(JSON.stringify(row));
    }
    return c.newResponse(lines.join("\n") + (lines.length > 0 ? "\n" : ""), 200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
    });
  });

  return app;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

function main(): void {
  const command = process.argv[2] ?? "serve";

  if (command === "backup") {
    const target = required("ICM_SYNC_BACKUP_PATH");
    const store = Store.open(required("ICM_SYNC_DB"));
    store.backupTo(target);
    console.log(`backup written to ${target}`);
    return;
  }

  const port = Number(process.env.PORT ?? 3000);
  const store = Store.open(required("ICM_SYNC_DB"));
  const app = createApp({ store, token: process.env.ICM_SYNC_TOKEN ?? "" });

  Bun.serve({
    port,
    fetch: app.fetch,
    idleTimeout: 30,
  });

  console.log(`icm-sync api listening on :${port}`);
}

if (import.meta.main) {
  main();
}
