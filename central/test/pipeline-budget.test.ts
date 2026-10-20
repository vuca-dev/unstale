// The scheduled pipeline's coverage budget (budget.ts): cached notes are free, uncached notes spend the shared period
// budget and the technology's quarterly tokens, and a refusal defers the note.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Limits } from "../src/onboarding/limits.ts";
import { PipelineBudget } from "../src/pipeline/budget.ts";
import { putExtractCache } from "../src/pipeline/llm.ts";
import { EXTRACT_PROMPT, fill, releaseCached } from "../src/pipeline/extract.ts";
import type { Technology } from "../src/pipeline/technologies.ts";

const prev = process.env.UNSTALE_CENTRAL_DIR;
beforeAll(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-pbudget-"));
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});

const limits = (over: Partial<Limits> = {}): Limits => ({
  perAddressPerHour: 20,
  votesPerAddressPerHour: 1000,
  runsPerDay: 1000,
  trustProxy: 0,
  tokensPerPeriod: 1_000,
  period: "day",
  techQuarterTokens: 300,
  ...over,
});
const notes = (tokens: number) => "x".repeat(tokens * 4);
const T0 = Date.UTC(2026, 9, 16, 12);

describe("PipelineBudget", () => {
  test("a cached note is free; an uncached one spends the period budget and the technology's quarter", () => {
    const dir = mkdtempSync(join(tmpdir(), "unstale-pb-"));
    const b = new PipelineBudget(limits(), join(dir, "quarters.json"), join(dir, "budget.json"));
    expect(b.charge("a", notes(900), true, false, T0)).toBe("cached");
    expect(b.tokensLeft(T0)).toBe(1_000);
    expect(b.charge("a", notes(200), false, false, T0)).toBe("ok");
    expect(b.tokensLeft(T0)).toBe(800);
  });

  test("past the quarterly cap a note is deferred (the first of a quarter always passes); lifting the cap lets it run", () => {
    const dir = mkdtempSync(join(tmpdir(), "unstale-pb-"));
    const b = new PipelineBudget(limits({ tokensPerPeriod: 10_000 }), join(dir, "quarters.json"), join(dir, "budget.json"));
    expect(b.charge("a", notes(500), false, false, T0)).toBe("ok"); // over the 300 cap, but the first of the quarter
    expect(b.charge("a", notes(10), false, false, T0)).toBe("cap");
    expect(b.charge("b", notes(100), false, false, T0)).toBe("ok"); // another technology is unaffected
    expect(b.charge("a", notes(10), false, true, T0)).toBe("ok");
    // A new quarter starts from zero.
    expect(b.charge("a", notes(10), false, false, Date.UTC(2027, 0, 2))).toBe("ok");
  });

  test("a spent period defers every uncached note until the next period; cached notes still run", () => {
    const dir = mkdtempSync(join(tmpdir(), "unstale-pb-"));
    const b = new PipelineBudget(limits({ tokensPerPeriod: 250, techQuarterTokens: 0 }), join(dir, "quarters.json"), join(dir, "budget.json"));
    expect(b.charge("a", notes(200), false, false, T0)).toBe("ok");
    expect(b.charge("b", notes(100), false, false, T0)).toBe("budget");
    expect(b.charge("b", notes(100), true, false, T0)).toBe("cached");
    expect(b.charge("b", notes(100), false, false, T0 + 86_400_000)).toBe("ok");
  });
});

describe("releaseCached", () => {
  test("true only when every chunk's first call is in the configured model's cache", () => {
    const t = { id: "zod", name: "zod", components: ["pkg:npm/zod"] } as unknown as Technology;
    const rel = { version: "4.1.0", date: "2026-08-20", notes: "## Breaking\n- `z.string().email()` is removed." } as Parameters<typeof releaseCached>[1];
    expect(releaseCached(t, rel)).toBe(false);
    putExtractCache(fill(EXTRACT_PROMPT, { TECH: t.name, VERSION: rel.version, DATE: rel.date, PART: "", NOTES: rel.notes }), "[]");
    expect(releaseCached(t, rel)).toBe(true);
  });
});
