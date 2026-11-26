import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Store } from "../src/api/store";
import { createApp } from "../src/api/index";
import { runSync, type SyncConfig, type SyncResult } from "../src/sync/client";
import { LocalDb } from "../src/sync/localdb";
import { makeLocalDb, makeRow, tempDir, removeDir } from "./helpers/fixture";

const directories: string[] = [];

interface Harness {
  dir: string;
  store: Store;
  sync: (device: SyncConfig) => Promise<SyncResult>;
  device: (name: string, dbRows?: ReturnType<typeof makeRow>[]) => SyncConfig;
  /** Overwrite a device's local database, standing in for local icm writes. */
  write: (name: string, rows: ReturnType<typeof makeRow>[]) => void;
  localRows: (name: string) => { id: string; summary: string }[];
}

function setup(token = "secret"): Harness {
  const dir = tempDir("icm-sync-e2e-");
  directories.push(dir);
  const store = Store.open(join(dir, "server.db"));
  const app = createApp({ store, token });

  // Route the client's fetch calls into the in-process Hono app.
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return app.request(url, init);
  }) as typeof fetch;

  const device = (name: string, rows: ReturnType<typeof makeRow>[] = []): SyncConfig => {
    const dbPath = join(dir, `${name}.db`);
    makeLocalDb(dbPath, rows);
    return {
      url: "http://icm-sync.test",
      token,
      deviceId: name,
      dbPath,
      statePath: join(dir, `${name}-state.json`),
      batch: 2,
      full: false,
      log: () => {},
    };
  };

  return {
    dir,
    store,
    device,
    write: (name: string, rows: ReturnType<typeof makeRow>[]) => {
      const db = LocalDb.open(join(dir, `${name}.db`));
      db.applySnapshot(rows);
      db.close();
    },
    localRows: (name: string) => {
      const db = LocalDb.open(join(dir, `${name}.db`));
      const rows = db.rows().map((entry) => ({
        id: entry.row.id,
        summary: entry.row.summary,
      }));
      db.close();
      return rows;
    },
    sync: (config) => runSync(config, fetchImpl),
  };
}

afterEach(() => {
  while (directories.length > 0) {
    removeDir(directories.pop()!);
  }
});

const STAMP_A = "2026-10-25T10:00:00.000000000+00:00";
const STAMP_B = "2026-10-25T11:00:00.000000000+00:00";
const STAMP_C = "2026-10-26T12:00:00.000000000+00:00";

describe("two device sync", () => {
  test("a row created on one device reaches the other", async () => {
    const h = setup();
    const shared = [makeRow({ id: "AAAAAAAA", updatedAt: STAMP_A })];
    const a = h.device("a", shared);
    const b = h.device("b", shared);

    await h.sync(a);
    await h.sync(b);

    const created = makeRow({ id: "CCCCCCCC", updatedAt: STAMP_B, summary: "created on a" });
    h.write("a", [...shared, created]);

    const result = await h.sync(a);
    expect(result.inserted).toBeGreaterThan(0);

    await h.sync(b);
    expect(h.localRows("b").map((row) => row.id).sort()).toEqual(["AAAAAAAA", "CCCCCCCC"]);
  });

  test("the newest edit wins on both devices", async () => {
    const h = setup();
    const base = makeRow({ id: "AAAAAAAA", updatedAt: STAMP_A, summary: "base" });
    const a = h.device("a", [base]);
    const b = h.device("b", [base]);

    await h.sync(a);
    await h.sync(b);

    const editedOnA = makeRow({ id: "AAAAAAAA", updatedAt: STAMP_C, summary: "edited on a" });
    const editedOnB = makeRow({ id: "AAAAAAAA", updatedAt: STAMP_B, summary: "edited on b" });

    h.write("a", [editedOnA]);
    h.write("b", [editedOnB]);

    await h.sync(a);
    const resultB = await h.sync(b);

    expect(resultB.inserted).toBe(0);
    expect(resultB.updated).toBe(0);
    for (const name of ["a", "b"]) {
      expect(h.localRows(name)).toEqual([{ id: "AAAAAAAA", summary: "edited on a" }]);
    }
  });

  test("a delete on one device removes the row on the other", async () => {
    const h = setup();
    const rows = [
      makeRow({ id: "AAAAAAAA", updatedAt: STAMP_A }),
      makeRow({ id: "BBBBBBBB", updatedAt: STAMP_B }),
    ];
    const a = h.device("a", rows);
    const b = h.device("b", rows);

    await h.sync(a);
    await h.sync(b);

    const keeper = rows[1]!;
    h.write("a", [keeper]);

    const deleted = await h.sync(a);
    expect(deleted.pushedDeletes).toBe(1);

    await h.sync(b);
    expect(h.localRows("b").map((row) => row.id)).toEqual(["BBBBBBBB"]);
  });

  test("syncing twice does not duplicate rows", async () => {
    const h = setup();
    const a = h.device("a", [makeRow({ id: "AAAAAAAA", updatedAt: STAMP_A })]);

    await h.sync(a);
    const second = await h.sync(a);

    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(h.localRows("a")).toHaveLength(1);
    expect(h.store.rowCount()).toBe(1);
  });

  test("a failed push leaves the local database untouched", async () => {
    const h = setup();
    const a = h.device("a", [makeRow({ id: "AAAAAAAA", updatedAt: STAMP_A })]);

    const failing = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const before = h.localRows("a");

    await expect(runSync({ ...a, full: true }, failing)).rejects.toThrow("push failed");

    expect(h.localRows("a")).toEqual(before);
    expect(h.store.rowCount()).toBe(0);
  });

  test("embeddings survive a round trip", async () => {
    const h = setup();
    const embedding = new Uint8Array(768 * 4);
    embedding[0] = 1;
    embedding[1] = 2;
    const row = makeRow({ id: "AAAAAAAA", updatedAt: STAMP_A, embedding });

    const a = h.device("a", [row]);
    const b = h.device("b", []);

    await h.sync(a);
    await h.sync(b);

    const dbB = LocalDb.open(b.dbPath);
    const stored = dbB.rows()[0]!.row;
    dbB.close();

    expect(stored.id).toBe("AAAAAAAA");
    expect(stored.embedding).not.toBeNull();
    expect(stored.embedding!.byteLength).toBe(768 * 4);
    expect(Array.from(stored.embedding!.slice(0, 2))).toEqual([1, 2]);
  });
});
