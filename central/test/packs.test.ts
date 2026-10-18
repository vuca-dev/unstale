// Cache packs (src/pipeline/packs.ts): values are the exact bytes a cache file held, the newest record wins, a torn
// record costs only itself, a store with one file per entry keeps its hits and moves into packs, and back.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, test } from "vitest";
import { ClassifierCache, type Classifier } from "../src/pipeline/classify/adapter.ts";
import { expandCaches, hashedPacks, migrateCaches, Packs, records } from "../src/pipeline/packs.ts";

const tmp = (): string => mkdtempSync(join(tmpdir(), "unstale-packs-"));
const put = (p: string, body: string | Buffer): void => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};
/** Every file under `dir`, path -> bytes (hex). */
function tree(dir: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, tree(dir, r));
    else out[r] = readFileSync(join(dir, r)).toString("hex");
  }
  return out;
}

test("values come back byte for byte, the newest record wins, and a name is only ever its own", () => {
  const p = new Packs(tmp(), { width: 1 });
  const binary = Buffer.from([0, 10, 123, 34, 107, 34, 58, 255, 10]);
  p.put("a", "one\n");
  p.put("b", binary);
  p.put("ab", '\n{"k":"a","n":3,"h":"0000000000000000"}\nbad');
  p.put("a", "two");
  expect(p.get("a")?.toString()).toBe("two");
  expect(p.get("b")?.equals(binary)).toBe(true);
  expect(p.get("ab")?.toString()).toBe('\n{"k":"a","n":3,"h":"0000000000000000"}\nbad');
  expect(p.has("c")).toBe(false);
  expect(() => p.get("../x")).toThrow(/not a pack entry name/);
  expect(Object.fromEntries([...p.entries()].map(([k, v]) => [k, v.toString("hex")]))).toEqual({ a: Buffer.from("two").toString("hex"), b: binary.toString("hex"), ab: Buffer.from('\n{"k":"a","n":3,"h":"0000000000000000"}\nbad').toString("hex") });
});

test("cache values are stored Brotli-compressed and read back as they were written", () => {
  const p = hashedPacks(tmp(), 3);
  const answer = JSON.stringify({ classifier: "jev", answers: Object.fromEntries([...Array(40)].map((_, i) => [`q${i}`, { choice: "no", confidence: 1 }])) }) + "\n";
  p.put("ab01", answer);
  expect(p.get("ab01")?.toString()).toBe(answer);
  expect(statSync(p.bucket("ab01")).size).toBeLessThan(answer.length / 3);
});

test("a torn record (a killed writer, a full disk) is skipped; the records before and after it still read", () => {
  const p = new Packs(tmp(), { width: 0 });
  p.put("first", "1".repeat(100));
  const file = p.bucket("first");
  p.put("torn", "2".repeat(100));
  truncateSync(file, statSync(file).size - 40);
  p.put("after", "3");
  expect(p.get("first")?.toString()).toBe("1".repeat(100));
  expect(p.get("torn")).toBeUndefined();
  expect(p.get("after")?.toString()).toBe("3");
  // A corrupted byte fails the record's checksum.
  appendFileSync(file, '\n{"k":"after","n":1,"h":"0000000000000000"}\n4');
  expect(p.get("after")?.toString()).toBe("3");
  expect(records(readFileSync(file)).map((r) => r.name)).toEqual(["first", "after"]);
});

test("bytes shaped like a record inside a value (a page can hold anything) are never read as one", () => {
  const p = new Packs(tmp(), { width: 0 });
  const forged = Buffer.from('{"at":"2099-01-01T00:00:00Z"}');
  const fake = Buffer.concat([Buffer.from(`\n{"k":"victim","n":${forged.length},"h":"${createHash("sha256").update(forged).digest("hex").slice(0, 16)}"}\n`), forged]);
  p.put("victim", "real");
  p.put("attacker", Buffer.concat([Buffer.from("padding"), fake, Buffer.from("tail")]));
  expect(p.get("victim")?.toString()).toBe("real");
  p.put("attacker2", Buffer.concat([Buffer.from("x"), fake]));
  expect(p.get("victim")?.toString()).toBe("real");
});

test("an overwritten pack is rewritten once mostly dead, keeping each name's newest value and what others appended", () => {
  const dir = tmp();
  const p = new Packs(dir, { width: 0 });
  const other = new Packs(dir, { width: 0 });
  for (let i = 0; i < 40; i++) p.put("times", `${i}`.padEnd(20_000, "x"));
  other.put("kept", "y");
  expect(statSync(p.bucket("times")).size).toBeLessThan(3 * 20_100);
  expect(p.get("times")?.toString()).toBe("39".padEnd(20_000, "x"));
  expect(p.get("kept")?.toString()).toBe("y");
});

test("a cache with one file per entry keeps its hits, moves into packs, and expands back to the same bytes", () => {
  const central = tmp();
  const files: Record<string, string> = {
    "cache/classifier/ab/ab01.json": '{"classifier":"jev"}\n',
    "cache/classifier/cd/cd02.json": '{"classifier":"chat"}',
    "cache/llm/ef/ef03.json": '{"text":"[]"}\n',
    "cache/llm/ef/ef03.length.json": '{"finish":"length"}\n',
    "cache/registry/npm/0011.json": '{"name":"x"}\n',
    "cache/registry/pypi/times/2233.json": '{"checked":"t"}\n',
  };
  for (const [rel, body] of Object.entries(files)) put(join(central, rel), body);
  const before = tree(central);
  const classifier = hashedPacks(join(central, "cache/classifier"), 3);
  expect(classifier.get("ab01")?.toString()).toBe('{"classifier":"jev"}\n');

  // A value packed before the migration (written since) wins over the legacy file.
  hashedPacks(join(central, "cache/llm"), 3).put("ef03", '{"text":"newer"}\n');
  expect(migrateCaches(central)).toBe(6);
  expect(Object.keys(tree(central)).every((f) => f.endsWith(".pack"))).toBe(true);
  expect(hashedPacks(join(central, "cache/llm"), 3).get("ef03")?.toString()).toBe('{"text":"newer"}\n');
  expect(migrateCaches(central)).toBe(0);

  hashedPacks(join(central, "cache/llm"), 3).put("ef03", '{"text":"[]"}\n');
  expect(expandCaches(central)).toBe(6);
  expect(tree(central)).toEqual(before);
});

test("the classifier cache hits an answer saved as a file before packs, under the same key", () => {
  const dir = tmp();
  const cache = new ClassifierCache(dir);
  const c = { name: "jev", model: "jev-1.13.0" } as unknown as Classifier;
  const key = cache.key(c, { a: 1 }, {} as never);
  put(join(dir, key.slice(0, 2), `${key}.json`), JSON.stringify({ classifier: "jev", answers: { x: 1 } }) + "\n");
  expect(cache.get(c, { a: 1 }, {} as never)).toEqual({ classifier: "jev", answers: { x: 1 } });
  cache.put(c, { a: 2 }, {} as never, { classifier: "jev", answers: { y: 2 } } as never);
  expect(cache.get(c, { a: 2 }, {} as never)).toEqual({ classifier: "jev", answers: { y: 2 } });
  expect(existsSync(join(dir, `${key.slice(0, 2)}`))).toBe(true);
});
