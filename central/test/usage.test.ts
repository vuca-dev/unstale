// Usage by phase (util.ts, usage.ts): every usage line carries the phase of the work that wrote it, jobs running at once
// never take each other's lines, and the summary splits onboarding from monitoring per provider.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { usageLog } from "../src/pipeline/paths.ts";
import { TECHNOLOGIES } from "../src/pipeline/technologies.ts";
import { jevAttribution, estimate, loadPrices, monitoredTechnologies, usageByPhase } from "../src/pipeline/usage.ts";
import { logUsage, withUsagePhase } from "../src/pipeline/util.ts";

const prev = process.env.UNSTALE_CENTRAL_DIR;
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "unstale-usage-"));
  process.env.UNSTALE_CENTRAL_DIR = dir;
});
afterAll(() => {
  if (prev === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prev;
});
beforeEach(() => rmSync(usageLog(), { force: true }));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lines = () => readFileSync(usageLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("usage phase", () => {
  test("two jobs interleaving: each call is attributed to its own job's phase and technology", async () => {
    // A model call deep in a job's chain, after awaits that hand the event loop to the other job.
    const call = async (job: string, i: number) => {
      await sleep(job === "a" ? 7 : 5);
      await Promise.resolve();
      logUsage({ api: "vercel", job, i, input_tokens: 10, output_tokens: 1 });
    };
    const job = (name: string, n: number) => async () => {
      for (let i = 0; i < n; i++) await Promise.all([call(name, i), (async () => (await sleep(1), call(name, i + 100)))()]);
    };
    await Promise.all([
      withUsagePhase("onboarding", "next", job("a", 4)),
      withUsagePhase("monitoring", "prisma", job("b", 4)),
    ]);
    logUsage({ api: "jev", job: "none" });
    const got = lines();
    expect(got).toHaveLength(17);
    // Interleaved, not one job after the other.
    expect(got.slice(0, 16).map((l) => l.job).join("")).not.toMatch(/^(a{8}b{8}|b{8}a{8})$/);
    for (const l of got.filter((l) => l.job === "a")) expect([l.phase, l.tech]).toEqual(["onboarding", "next"]);
    for (const l of got.filter((l) => l.job === "b")) expect([l.phase, l.tech]).toEqual(["monitoring", "prisma"]);
    // Outside any job: `other`, no technology.
    expect(got.at(-1)).toMatchObject({ phase: "other", api: "jev" });
    expect(got.at(-1)!.tech).toBeUndefined();
  });

  test("a context nested in another wins for its own chain; an explicit phase on the line wins over the context", async () => {
    await withUsagePhase("monitoring", "next", async () => {
      await withUsagePhase("onboarding", "nuxt", async () => logUsage({ api: "jev", n: 1 }));
      logUsage({ api: "jev", n: 2 });
      logUsage({ milestone: "onboarded", phase: "onboarding", tech: "astro" });
    });
    expect(lines().map((l) => [l.phase, l.tech])).toEqual([
      ["onboarding", "nuxt"],
      ["monitoring", "next"],
      ["onboarding", "astro"],
    ]);
  });
});

describe("usage summary", () => {
  test("per-phase totals per provider, dollars reported or estimated, onboarded and monitored counts, per-technology figures", () => {
    const at = (d: number) => new Date(Date.UTC(2026, 9, 1 + d)).toISOString();
    const log = [
      { api: "vercel", input_tokens: 100, output_tokens: 10, at: at(0) }, // before phases: unattributed
      { phase: "onboarding", tech: "next", api: "vercel", input_tokens: 1000, output_tokens: 100, dollars: 0.002, at: at(1) },
      { phase: "onboarding", tech: "next", api: "jev", input_tokens: 500, output_tokens: 5, at: at(1) },
      { phase: "onboarding", tech: "next", milestone: "onboarded", at: at(1) },
      { phase: "onboarding", tech: "nuxt", api: "vercel", input_tokens: 3000, output_tokens: 300, dollars: 0.006, at: at(2) },
      { phase: "monitoring", tech: "prisma", api: "vercel", input_tokens: 200, output_tokens: 20, dollars: 0.0004, at: at(3) },
      { phase: "monitoring", tech: "next", api: "jev", input_tokens: 50, output_tokens: 1, at: at(5) },
      { phase: "other", event: "jev-disabled", at: at(5) },
    ];
    // Jev reports no charge: priced from the list (its only entry, whatever the model version).
    const s = usageByPhase(log, 4, [{ provider: "jev", model: "jev-latest", input: 0.042, output: 0 }]);
    expect(s).toEqual({
      // Lines without a phase are summed (unattributed) but are outside the window: it starts at the first phase.
      window: { from: at(1), to: at(5), days: 4 },
      phases: {
        unattributed: {
          providers: { vercel: { calls: 1, input_tokens: 100, output_tokens: 10, dollars: 0, estimated_calls: 0, unpriced_calls: 1 } },
          total: { calls: 1, input_tokens: 100, output_tokens: 10, dollars: 0, estimated_calls: 0, unpriced_calls: 1 },
          technologies: 0,
        },
        onboarding: {
          providers: {
            vercel: { calls: 2, input_tokens: 4000, output_tokens: 400, dollars: 0.008, estimated_calls: 0, unpriced_calls: 0 },
            jev: { calls: 1, input_tokens: 500, output_tokens: 5, dollars: 0.000021, estimated_calls: 1, unpriced_calls: 0 },
          },
          total: { calls: 3, input_tokens: 4500, output_tokens: 405, dollars: 0.008021, estimated_calls: 1, unpriced_calls: 0 },
          technologies: 2,
        },
        monitoring: {
          providers: {
            vercel: { calls: 1, input_tokens: 200, output_tokens: 20, dollars: 0.0004, estimated_calls: 0, unpriced_calls: 0 },
            jev: { calls: 1, input_tokens: 50, output_tokens: 1, dollars: 0.000002, estimated_calls: 1, unpriced_calls: 0 },
          },
          total: { calls: 2, input_tokens: 250, output_tokens: 21, dollars: 0.000402, estimated_calls: 1, unpriced_calls: 0 },
          technologies: 2,
        },
      },
      onboarded: 1,
      monitored: 4,
      per_onboarded_technology: { dollars: 0.008021, input_tokens: 4500, output_tokens: 405 },
      // 250 tokens over 4 technologies in 4 days, scaled to 365.
      monitoring_per_technology_year: { dollars: 0.009171, input_tokens: 5703, output_tokens: 479 },
    });
    // Machine-readable as it is printed.
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    // A month of untagged lines and a day of tagged ones: the year is scaled from the day, not the month.
    const day = usageByPhase(
      [
        { api: "vercel", input_tokens: 1, output_tokens: 1, at: at(0) },
        { phase: "monitoring", tech: "next", api: "vercel", input_tokens: 10, output_tokens: 0, dollars: 0.01, at: at(29) },
        { phase: "monitoring", tech: "next", api: "vercel", input_tokens: 10, output_tokens: 0, dollars: 0.01, at: at(30) },
      ],
      1,
    );
    expect(day.window).toEqual({ from: at(29), to: at(30), days: 1 });
    expect(day.monitoring_per_technology_year?.dollars).toBe(7.3);
    // No line with a phase: no window, no per-year figure.
    expect(usageByPhase([{ api: "vercel", input_tokens: 1, output_tokens: 1, at: at(0) }], 1)).toMatchObject({ window: { from: null, to: null, days: 0 }, monitoring_per_technology_year: null });
  });

  test("estimates: cached input at its own price, an unknown model or price is no estimate; the repository's list loads", () => {
    const prices = [
      { provider: "codex", model: "gpt-5.6-luna", input: 0.2, cached_input: 0.02, output: 1.2 },
      { provider: "codex", model: "other", input: 1, output: 1 },
      { provider: "cloudflare", model: "m", input: 0.038, output: null },
    ];
    expect(estimate(prices, { api: "codex", model: "gpt-5.6-luna", input_tokens: 1_000_000, cached_input_tokens: 400_000, output_tokens: 100_000 })).toBeCloseTo(0.12 + 0.008 + 0.12, 9);
    // Two codex models listed: an unknown one is not guessed.
    expect(estimate(prices, { api: "codex", model: "gpt-9", input_tokens: 10 })).toBeUndefined();
    expect(estimate(prices, { api: "cloudflare", model: "m", input_tokens: 10 })).toBeUndefined();
    expect(loadPrices().some((p) => p.provider === "jev")).toBe(true);
  });

  test("an empty log has no window and no per-technology figures", () => {
    expect(usageByPhase([], 3)).toEqual({
      window: { from: null, to: null, days: 0 },
      phases: {},
      onboarded: 0,
      monitored: 3,
      per_onboarded_technology: null,
      monitoring_per_technology_year: null,
    });
  });

  test("monitored: the catalog technologies and monitored onboarding jobs, merged ones and duplicates not counted", () => {
    const jobs = join(dir, "onboarding", "jobs");
    mkdirSync(jobs, { recursive: true });
    const write = (n: string, job: Record<string, unknown>) => writeFileSync(join(jobs, `${n}.json`), JSON.stringify(job));
    write("1", { state: "monitoring", technology: "left-pad" });
    write("2", { state: "monitoring", technology: "left-pad-sibling", merged_into: "pkg:npm/left-pad" });
    write("3", { state: "queued", technology: "is-odd" });
    write("4", { state: "monitoring", technology: Object.keys(TECHNOLOGIES)[0] });
    expect(monitoredTechnologies()).toBe(Object.keys(TECHNOLOGIES).length + 1);
  });
});

test("Jev attribution isolates a run and attempt, ranks sources, and does not count events as calls", () => {
  const oldAttempt = process.env.GITHUB_RUN_ATTEMPT;
  process.env.GITHUB_RUN_ATTEMPT = "2";
  try {
    const prices = [{ provider: "jev", model: "jev-latest", input: 0.042, output: 0 }];
    const call = { api: "jev", run: "123", run_attempt: "2", phase: "onboarding", technology: "React", stage: "labelling", source: "release notes", input_tokens: 1000, output_tokens: 10 };
    const result = jevAttribution([
      { ...call, run: "122", input_tokens: 900000 },
      { ...call, run_attempt: "1", input_tokens: 800000 },
      call, { ...call, stage: "matching", input_tokens: 2000 },
      { ...call, source: "official documentation change", input_tokens: 500 },
      { event: "jev-disabled", run: "123", run_attempt: "2" },
    ], prices, "123");
    expect(result).toMatchObject({ scope: "actions_run", run_attempt: "2", calls: 3, input_tokens: 3500, output_tokens: 30,
      top: [{ stage: "matching", calls: 1, dollars: 0.000084, output_tokens: 10 }, { stage: "labelling", source: "release notes", calls: 1, dollars: 0.000042 }, { stage: "labelling", source: "official documentation change", input_tokens: 500 }] });
  } finally {
    if (oldAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = oldAttempt;
  }
});

test("sample retries move to the end and retained-log scope does not invent an Actions attempt", () => {
  const calls = Array.from({ length: 10 }, (_, i) => ({ api: "jev", request: String(i), sample: { subject: String(i) } }));
  const result = jevAttribution([...calls, calls[0]!], [], "") as { samples: { subject: string }[]; run_attempt: unknown };
  expect(result.samples.map((s) => s.subject)).toEqual(["3", "4", "5", "6", "7", "8", "9", "0"]);
  expect(result.run_attempt).toBeNull();
});
