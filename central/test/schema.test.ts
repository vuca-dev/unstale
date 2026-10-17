// The schema seam's contract, TypeScript side. The Rust side is local/schema/tests/contract.rs.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { generate } from "../scripts/gen-zod.ts";
import { ShardLine, TechIndex } from "../src/schema/catalog.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const lines = (file: string) =>
  readFileSync(join(ROOT, "schema", "fixtures", file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const active = () => lines("ts-shard.v1.jsonl").find((l) => l.status === "active")!;

describe("schema seam", () => {
  test("generated Zod is current with the JSON Schema", () => {
    expect(readFileSync(join(ROOT, "central", "src", "schema", "catalog.ts"), "utf8")).toBe(generate());
  });

  test("accepts every line Rust wrote, including every optional field", () => {
    const rust = lines("rust-shard.v1.jsonl");
    expect(rust.length).toBeGreaterThan(5);
    for (const l of rust) expect(ShardLine.safeParse(l).error).toBeUndefined();
    expect(rust.at(-1)).toMatchObject({ facet: "options", supersedes: "node:old-diff" });
    expect(rust.at(-1)).toMatchObject({ classifier: { classifier: "jev", borderline: ["surface", "benefit:security"] } });
  });

  test("classifier output: known values pass; unknown classifiers, fields and missing scores are rejected", () => {
    const c = {
      classifier: "openai-decisions",
      model: "gpt-6-luna",
      change_type: 0.8,
      surface: 0.7,
      breaking: 0.2,
      benefit: [{ benefit: "cost", p: 0.6 }],
    };
    const ok = ShardLine.safeParse({ ...active(), classifier: c });
    expect(ok.error).toBeUndefined();
    expect((ok.data as { classifier: { borderline: string[] } }).classifier.borderline).toEqual([]);
    expect(ShardLine.safeParse({ ...active(), classifier: { ...c, classifier: "clef" } }).success).toBe(false);
    expect(ShardLine.safeParse({ ...active(), classifier: { ...c, extra: 1 } }).success).toBe(false);
    expect(ShardLine.safeParse({ ...active(), classifier: { ...c, benefit: [{ benefit: "joy", p: 1 }] } }).success).toBe(false);
    const { breaking: _, ...noBreaking } = c;
    expect(ShardLine.safeParse({ ...active(), classifier: noBreaking }).success).toBe(false);
    expect(ShardLine.safeParse({ ...active(), classifier: { ...c, breaking: "high" } }).success).toBe(false);
  });

  test("the writer is strict: unknown fields, values and statuses are rejected", () => {
    expect(ShardLine.safeParse({ ...active(), extra: 1 }).success).toBe(false);
    expect(ShardLine.safeParse({ ...active(), change_type: "quantum_change" }).success).toBe(false);
    expect(ShardLine.safeParse({ status: "unknown" }).success).toBe(false);
    expect(ShardLine.safeParse({ status: "merged", id: "a" }).success).toBe(false);
    const { summary: _, ...noSummary } = active();
    expect(ShardLine.safeParse(noSummary).success).toBe(false);
  });

  test("defaulted fields are always present in what the writer publishes", () => {
    const { terms: _t, requires: _r, ...sparse } = active();
    const out = ShardLine.parse(sparse) as Record<string, unknown>;
    expect(out.terms).toEqual([]);
    expect(out.requires).toEqual([]);
  });

  test("classifier names: jev, codex and the older openai-decisions are accepted; an unknown one is not written", () => {
    const base = active();
    const cls = (base.classifier ?? { model: "m", change_type: 1, surface: 1, breaking: 0, benefit: [], borderline: [] }) as Record<string, unknown>;
    for (const name of ["jev", "codex", "openai-decisions"]) {
      expect(ShardLine.safeParse({ ...base, classifier: { ...cls, classifier: name } }).error).toBeUndefined();
    }
    expect(ShardLine.safeParse({ ...base, classifier: { ...cls, classifier: "clef" } }).success).toBe(false);
  });

  test("tech index rejects a negative or fractional count", () => {
    const idx = { schema: 1, technology: "next", sample_n: 5, checked: "2026-10-15T00:00:00Z", shards: [] };
    expect(TechIndex.safeParse(idx).success).toBe(true);
    expect(TechIndex.safeParse({ ...idx, sample_n: -1 }).success).toBe(false);
    expect(TechIndex.safeParse({ ...idx, sample_n: 1.5 }).success).toBe(false);
  });

  test("tech index: the sample list Rust wrote is accepted; a malformed sample entry is not", () => {
    const rust = JSON.parse(readFileSync(join(ROOT, "schema", "fixtures", "rust-index.v1.json"), "utf8")) as Record<string, unknown>;
    expect(TechIndex.safeParse(rust).error).toBeUndefined();
    expect(rust.sample).toEqual([{ repo: "a/b", commit: "0".repeat(40) }]);
    const idx = { schema: 1, technology: "next", sample_n: 1, checked: "x", shards: [] };
    expect(TechIndex.safeParse({ ...idx, sample: [{ repo: "a/b" }] }).success).toBe(false);
    expect(TechIndex.safeParse({ ...idx, sample: [{ repo: "a/b", commit: "c", stars: 1 }] }).success).toBe(false);
  });
});
