// Shard prune: a shard no current index references is deleted only when the index that last referenced it was
// replaced more than 7 days ago; a referenced shard never is; a shard without history starts its clock at first sight;
// a dry run changes nothing; publishing records the history without changing a rerun's bytes.
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { pruneCatalog } from "../src/pipeline/prune.ts";
import { publishTechnology } from "../src/pipeline/publish.ts";
import { store } from "./catalog-fixture.ts";

const CHECKED = "2026-10-15T06:00:00Z";
const T0 = new Date("2026-10-01T00:00:00Z");
const days = (n: number): Date => new Date(T0.getTime() + n * 24 * 3600 * 1000);
const index = (dir: string): string[] =>
  (JSON.parse(readFileSync(join(dir, "v1", "tech", "next.json"), "utf8")) as { shards: { path: string }[] }).shards.map((s) => s.path);
const shards = (dir: string): string[] => readdirSync(join(dir, "v1", "shards", "next")).map((n) => `v1/shards/next/${n}`).sort();
const history = (dir: string): Record<string, string> =>
  (JSON.parse(readFileSync(join(dir, "history", "next.json"), "utf8")) as { unreferenced_since: Record<string, string> }).unreferenced_since;

const previous = process.env.UNSTALE_CENTRAL_DIR;
beforeEach(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-prune-central-")); // technology locks
});
afterEach(() => {
  if (previous === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = previous;
});

/** Line 16 published at T0, then replaced at day 1: its first shard is unreferenced since day 1. */
function replaced(): { dir: string; old: string; current: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "unstale-prune-"));
  publishTechnology(store(), CHECKED, dir, undefined, T0);
  const before = index(dir);
  publishTechnology(store("Adds b, corrected."), CHECKED, dir, undefined, days(1));
  const current = index(dir);
  const old = before.find((p) => !current.includes(p))!;
  return { dir, old, current };
}

describe("prune", () => {
  test("publishing records when a shard stopped being referenced; an unchanged rerun writes nothing new", () => {
    const { dir, old, current } = replaced();
    expect(current).toHaveLength(2);
    expect(history(dir)).toEqual({ [old]: days(1).toISOString() });
    const text = readFileSync(join(dir, "history", "next.json"), "utf8");
    publishTechnology(store("Adds b, corrected."), CHECKED, dir, undefined, days(3));
    expect(readFileSync(join(dir, "history", "next.json"), "utf8")).toBe(text);
    // A first publish has replaced nothing: no history file at all.
    const fresh = mkdtempSync(join(tmpdir(), "unstale-prune-"));
    publishTechnology(store(), CHECKED, fresh, undefined, T0);
    expect(existsSync(join(fresh, "history"))).toBe(false);
  });

  test("unreferenced but recent: kept", () => {
    const { dir, old } = replaced();
    const r = pruneCatalog(dir, { now: days(7) }); // 6 days after the replacement
    expect(r.deleted).toEqual([]);
    expect(r.kept).toEqual([old]);
    expect(shards(dir)).toContain(old);
  });

  test("unreferenced for more than 7 days: deleted, and its history entry with it", () => {
    const { dir, old, current } = replaced();
    const r = pruneCatalog(dir, { now: days(8.01) });
    expect(r.deleted).toEqual([old]);
    expect(shards(dir)).toEqual([...current].sort());
    expect(history(dir)).toEqual({});
  });

  test("referenced shards are never deleted, whatever their history says", () => {
    const { dir, current } = replaced();
    const h = JSON.parse(readFileSync(join(dir, "history", "next.json"), "utf8"));
    for (const p of current) h.unreferenced_since[p] = "2020-01-01T00:00:00.000Z";
    writeFileSync(join(dir, "history", "next.json"), JSON.stringify(h));
    const r = pruneCatalog(dir, { now: days(400) });
    for (const p of current) expect(r.deleted).not.toContain(p);
    expect(shards(dir)).toEqual([...current].sort());
    for (const p of current) expect(history(dir)[p]).toBeUndefined();
  });

  test("a shard with no history is kept and its clock starts at first sight", () => {
    const { dir, current } = replaced();
    const stray = "v1/shards/next/14.0123456789abcdef.jsonl.gz";
    copyFileSync(join(dir, current[0]!), join(dir, stray));
    const first = pruneCatalog(dir, { now: days(30) });
    expect(first.started).toEqual([stray]);
    expect(first.deleted).not.toContain(stray);
    expect(history(dir)[stray]).toBe(days(30).toISOString());
    expect(pruneCatalog(dir, { now: days(36) }).deleted).not.toContain(stray);
    expect(pruneCatalog(dir, { now: days(37.01) }).deleted).toContain(stray);
    expect(existsSync(join(dir, stray))).toBe(false);
  });

  test("a dry run deletes nothing and writes no history", () => {
    const { dir, old } = replaced();
    const stray = "v1/shards/next/14.0123456789abcdef.jsonl.gz";
    copyFileSync(join(dir, old), join(dir, stray));
    const before = readFileSync(join(dir, "history", "next.json"), "utf8");
    const r = pruneCatalog(dir, { now: days(100), dryRun: true });
    expect(r.deleted).toEqual([old]);
    expect(r.started).toEqual([stray]);
    expect(existsSync(join(dir, old))).toBe(true);
    expect(readFileSync(join(dir, "history", "next.json"), "utf8")).toBe(before);
  });

  test("an unreadable index blocks every deletion", () => {
    const { dir, old } = replaced();
    writeFileSync(join(dir, "v1", "tech", "other.json"), "{ not json");
    const r = pruneCatalog(dir, { now: days(100) });
    expect(r.unreadable).toEqual(["v1/tech/other.json"]);
    expect(r.deleted).toEqual([]);
    expect(existsSync(join(dir, old))).toBe(true);
  });

  test("a shard named again by a later index leaves the history", () => {
    const { dir, old } = replaced();
    publishTechnology(store(), CHECKED, dir, undefined, days(2)); // back to the first content: same shard name
    expect(index(dir)).toContain(old);
    expect(history(dir)[old]).toBeUndefined();
    expect(pruneCatalog(dir, { now: days(100) }).deleted).not.toContain(old);
  });
});
