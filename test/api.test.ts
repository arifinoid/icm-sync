import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Store } from "../src/api/store";
import { createApp } from "../src/api/index";
import { makeRow, tempDir, removeDir } from "./helpers/fixture";
import { toWire } from "../src/shared/wire";

const directories: string[] = [];

function setup(): { app: ReturnType<typeof createApp>; store: Store; dir: string } {
  const dir = tempDir("icm-sync-api-");
  directories.push(dir);
  const store = Store.open(join(dir, "server.db"));
  const app = createApp({ store, token: "secret" });
  return { app, store, dir };
}

afterEach(() => {
  while (directories.length > 0) {
    removeDir(directories.pop()!);
  }
});

describe("auth", () => {
  test("rejects a push without a token", async () => {
    const { app } = setup();
    const response = await app.request("/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_id: "a", rows: [], deleted: [] }),
    });
    expect(response.status).toBe(401);
  });

  test("rejects a push with the wrong token", async () => {
    const { app } = setup();
    const response = await app.request("/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer nope" },
      body: JSON.stringify({ device_id: "a", rows: [], deleted: [] }),
    });
    expect(response.status).toBe(401);
  });

  test("healthz is public", async () => {
    const { app } = setup();
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, rows: 0, tombstones: 0 });
  });
});

describe("push", () => {
  test("inserts rows and reports the count", async () => {
    const { app } = setup();
    const row = toWire(makeRow({ id: "AAAAAAAA" }));
    const response = await app.request("/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: JSON.stringify({ device_id: "a", rows: [row], deleted: [] }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ inserted: 1, updated: 0, skipped: 0, server_rows: 1 });
  });

  test("ignores a stale row and keeps the newer stored one", async () => {
    const { app } = setup();
    const headers = { "Content-Type": "application/json", Authorization: "Bearer secret" };
    const newer = toWire(makeRow({ id: "AAAAAAAA", updatedAt: "2026-10-26T10:00:00.000000000+00:00" }));
    const older = toWire(makeRow({ id: "AAAAAAAA", updatedAt: "2026-10-25T10:00:00.000000000+00:00", summary: "stale" }));

    await app.request("/v1/push", {
      method: "POST",
      headers,
      body: JSON.stringify({ device_id: "a", rows: [newer], deleted: [] }),
    });
    const second = await app.request("/v1/push", {
      method: "POST",
      headers,
      body: JSON.stringify({ device_id: "b", rows: [older], deleted: [] }),
    });
    expect(await second.json()).toMatchObject({ inserted: 0, updated: 0, skipped: 1 });

    const snapshot = await app.request("/v1/snapshot", { headers });
    const lines = (await snapshot.text()).trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0].summary).toBe(newer.summary);
  });

  test("rejects a malformed body", async () => {
    const { app } = setup();
    const response = await app.request("/v1/push", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
      body: JSON.stringify({ device_id: "a", rows: [{ id: 1 }], deleted: [] }),
    });
    expect(response.status).toBe(400);
  });
});

describe("delete", () => {
  test("removes the row and records a tombstone", async () => {
    const { app, store } = setup();
    const headers = { "Content-Type": "application/json", Authorization: "Bearer secret" };
    const row = toWire(makeRow({ id: "AAAAAAAA", updatedAt: "2026-10-25T10:00:00.000000000+00:00" }));
    await app.request("/v1/push", {
      method: "POST",
      headers,
      body: JSON.stringify({ device_id: "a", rows: [row], deleted: [] }),
    });

    const response = await app.request("/v1/push", {
      method: "POST",
      headers,
      body: JSON.stringify({
        device_id: "a",
        rows: [],
        deleted: [{ id: "AAAAAAAA", updated_ms: Date.parse("2026-10-25T10:00:00.000000000+00:00") }],
      }),
    });
    expect(await response.json()).toMatchObject({ deleted: 1 });
    expect(store.rowCount()).toBe(0);
    expect(store.tombstoneCount()).toBe(1);
  });

  test("a delete older than the row does not remove it", async () => {
    const { app, store } = setup();
    const headers = { "Content-Type": "application/json", Authorization: "Bearer secret" };
    const row = toWire(makeRow({ id: "AAAAAAAA", updatedAt: "2026-10-26T10:00:00.000000000+00:00" }));
    await app.request("/v1/push", {
      method: "POST",
      headers,
      body: JSON.stringify({ device_id: "a", rows: [row], deleted: [] }),
    });

    const response = await app.request("/v1/push", {
      method: "POST",
      headers,
      body: JSON.stringify({ device_id: "b", rows: [], deleted: [{ id: "AAAAAAAA", updated_ms: 1 }] }),
    });
    expect(await response.json()).toMatchObject({ deleted: 0 });
    expect(store.rowCount()).toBe(1);
  });
});
