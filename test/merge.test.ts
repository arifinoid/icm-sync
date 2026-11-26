import { describe, expect, test } from "bun:test";
import { deleteWins, incomingWins, planRowUpdates } from "../src/shared/merge";

describe("incomingWins", () => {
  test("a new row always wins", () => {
    expect(incomingWins(null, 100)).toBe(true);
  });

  test("a strictly newer row wins", () => {
    expect(incomingWins(100, 101)).toBe(true);
  });

  test("an older or equally new row loses", () => {
    expect(incomingWins(100, 99)).toBe(false);
    expect(incomingWins(100, 100)).toBe(false);
  });
});

describe("deleteWins", () => {
  test("deletes a row that is not newer than the marker", () => {
    expect(deleteWins(100, 100)).toBe(true);
    expect(deleteWins(99, 100)).toBe(true);
  });

  test("keeps a row edited after the delete was issued", () => {
    expect(deleteWins(101, 100)).toBe(false);
  });

  test("deletes a row the server has never seen", () => {
    expect(deleteWins(null, 0)).toBe(true);
  });
});

describe("planRowUpdates", () => {
  test("splits incoming rows into apply and skipped", () => {
    const stored = new Map([
      ["a", 100],
      ["b", 50],
    ]);
    const plan = planRowUpdates(stored, [
      { id: "a", updated_ms: 99 },
      { id: "b", updated_ms: 51 },
      { id: "c", updated_ms: 1 },
    ]);
    expect(plan.apply).toEqual(["b", "c"]);
    expect(plan.skipped).toEqual(["a"]);
  });
});
