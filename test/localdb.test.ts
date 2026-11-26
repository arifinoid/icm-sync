import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { LocalDb } from "../src/sync/localdb";
import { makeLocalDb, makeRow, tempDir, removeDir } from "./helpers/fixture";

const directories: string[] = [];

const STAMP_A = "2026-10-25T10:00:00.000000000+00:00";
const STAMP_B = "2026-10-25T11:00:00.000000000+00:00";
const STAMP_C = "2026-10-26T12:00:00.000000000+00:00";

function openDb(name: string, rows: ReturnType<typeof makeRow>[] = []): LocalDb {
  const dir = tempDir("icm-sync-localdb-");
  directories.push(dir);
  const path = join(dir, `${name}.db`);
  makeLocalDb(path, rows);
  return LocalDb.open(path);
}

function ids(db: LocalDb): string[] {
  return db
    .rows()
    .map((entry) => entry.row.id)
    .sort();
}

afterEach(() => {
  while (directories.length > 0) {
    removeDir(directories.pop()!);
  }
});

describe("applySnapshot with a repeated summary_hash", () => {
  test("replaces a local row that shares its hash with an incoming id", () => {
    const local = makeRow({ id: "AAAAAAAA", updatedAt: STAMP_A, summaryHash: "shared" });
    const incoming = makeRow({ id: "BBBBBBBB", updatedAt: STAMP_B, summaryHash: "shared" });
    const db = openDb("twin", [local]);

    const result = db.applySnapshot([incoming]);

    expect(ids(db)).toEqual(["BBBBBBBB"]);
    expect(result.applied).toBe(1);
    // The twin is removed by the hash rule, not counted as a server-side delete.
    expect(result.deleted).toBe(0);
  });

  test("keeps one row when the snapshot itself repeats a hash", () => {
    const older = makeRow({ id: "AAAAAAAA", updatedAt: STAMP_A, summaryHash: "shared" });
    const newer = makeRow({ id: "BBBBBBBB", updatedAt: STAMP_B, summaryHash: "shared" });
    const db = openDb("repeat");

    const result = db.applySnapshot([older, newer]);

    expect(ids(db)).toEqual(["BBBBBBBB"]);
    expect(result.applied).toBe(1);
  });

  test("keeps the first row when the repeated hash is equally new", () => {
    const first = makeRow({ id: "AAAAAAAA", updatedAt: STAMP_A, summaryHash: "shared" });
    const second = makeRow({ id: "BBBBBBBB", updatedAt: STAMP_A, summaryHash: "shared" });
    const db = openDb("tie");

    db.applySnapshot([first, second]);

    expect(ids(db)).toEqual(["AAAAAAAA"]);
  });

  test("rows without a hash are never de-duplicated", () => {
    const rows = [
      makeRow({ id: "AAAAAAAA", updatedAt: STAMP_A, summaryHash: null }),
      makeRow({ id: "BBBBBBBB", updatedAt: STAMP_B, summaryHash: null }),
    ];
    const db = openDb("unhashed");

    const result = db.applySnapshot(rows);

    expect(ids(db)).toEqual(["AAAAAAAA", "BBBBBBBB"]);
    expect(result.applied).toBe(2);
  });

  test("a snapshot row replaces a newer local twin without failing", () => {
    const local = makeRow({ id: "AAAAAAAA", updatedAt: STAMP_C, summaryHash: "shared" });
    const incoming = makeRow({ id: "BBBBBBBB", updatedAt: STAMP_B, summaryHash: "shared" });
    const db = openDb("newer-twin", [local]);

    db.applySnapshot([incoming]);

    expect(ids(db)).toEqual(["BBBBBBBB"]);
  });
});
