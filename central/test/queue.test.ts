// The admission queue: votes by distinct requesters, drain order by tier then demand with no aging, the release-note
// token budget per period (persisted, fails closed), the per-technology quarterly cap, the technology unit (one
// repository and release stream) and the deprecation notice.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoverageService, sameStream, type Job } from "../src/onboarding/service.ts";
import { DailyBudget, nextPeriod, periodKey, quarterKey, Voters, type Limits } from "../src/onboarding/limits.ts";
import { deprecationOf } from "../src/onboarding/notices.ts";
import { servedIndex } from "../src/pipeline/export.ts";
import type { PublicTechnology } from "../src/onboarding/discovery.ts";

let dir: string;
const previous = process.env.UNSTALE_STORE;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unstale-queue-"));
  process.env.UNSTALE_STORE = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.UNSTALE_STORE;
  else process.env.UNSTALE_STORE = previous;
  vi.restoreAllMocks();
});

const limits = (l: Partial<Limits> = {}): Limits => ({
  perAddressPerHour: 100,
  newPerDay: 100,
  runsPerDay: 100,
  trustProxy: 0,
  tokensPerPeriod: 1_000_000,
  period: "day",
  techQuarterTokens: 50_000,
  ...l,
});

test("a request for a queued technology is a vote: one per requester, within the address limit, persisted as a count", () => {
  const service = new CoverageService(0, { limits: limits({ perAddressPerHour: 3 }) });
  service.register("pkg:npm/a", "198.51.100.1");
  service.register("pkg:npm/a", "198.51.100.1");
  service.register("pkg:npm/a", "198.51.100.2");
  expect(service.jobs.get("pkg:npm/a")?.demand).toBe(2);
  // Over the address limit the answer is the same job, but the vote does not count.
  service.register("pkg:npm/b", "198.51.100.3");
  service.register("pkg:npm/c", "198.51.100.3");
  service.register("pkg:npm/d", "198.51.100.3");
  expect(service.register("pkg:npm/a", "198.51.100.3")).toMatchObject({ purl: "pkg:npm/a" });
  expect(service.jobs.get("pkg:npm/a")?.demand).toBe(2);
  // Persisted: a restart keeps the counts (and nothing about who voted).
  expect(new CoverageService(0, { limits: limits() }).jobs.get("pkg:npm/a")?.demand).toBe(2);
});

test("the voter table holds no address and is bounded", () => {
  const v = new Voters(2);
  v.add("pkg:npm/a", "198.51.100.1");
  expect(v.has("pkg:npm/a", "198.51.100.1")).toBe(true);
  expect(v.has("pkg:npm/b", "198.51.100.1")).toBe(false);
  expect(JSON.stringify([...(v as unknown as { seen: Map<string, true> }).seen.keys()])).not.toContain("198.51.100.1");
  v.add("pkg:npm/b", "198.51.100.1");
  v.add("pkg:npm/c", "198.51.100.1");
  expect(v.has("pkg:npm/a", "198.51.100.1")).toBe(false);
});

test("drain order: admitted work first, then new technologies by demand with no aging, then quarterly overflow", () => {
  const service = new CoverageService(0, { limits: limits() });
  const old = service.submit("pkg:npm/old"); // requested long ago, one requester
  old.demand = 1;
  old.updated = "2020-01-01T00:00:00Z";
  const popular = service.submit("pkg:npm/popular");
  popular.demand = 100;
  const middle = service.submit("pkg:npm/middle");
  middle.demand = 5;
  const tie = service.submit("pkg:npm/tie");
  tie.demand = 5;
  const continuing = service.submit("pkg:npm/continuing");
  continuing.admitted = "maintained and used";
  const overflow = service.submit("pkg:npm/overflow");
  overflow.admitted = "maintained and used";
  overflow.demand = 1_000;
  overflow.overflow = quarterKey();
  const parked = service.submit("pkg:npm/parked");
  parked.state = "blocked";
  parked.retry_at = new Date(Date.now() + 86_400_000).toISOString();
  expect(service.queue().map((j) => j.purl.slice(8))).toEqual(["continuing", "popular", "middle", "tie", "old", "overflow"]);
  // A quarter later the cap has reset: the overflowing technology is ordinary admitted work again.
  overflow.overflow = "2000-Q1";
  expect(service.queue()[0]!.purl).toBe("pkg:npm/overflow");
  const status = service.publicStatus(middle);
  expect(status).toMatchObject({ queue_position: 4, queue_length: 6 });
  expect(status.stage).toContain("(position 4 of 6)");
  expect(status).not.toHaveProperty("demand_voters");
  expect(service.publicStatus(parked)).not.toHaveProperty("queue_position");
});

test("token budget per period: spent per note, persisted, reset each period, first spend always passes, fails closed", () => {
  const path = join(dir, "budget.json");
  const t0 = Date.UTC(2026, 9, 16, 12);
  const b = new DailyBudget({ newPerDay: 10, runsPerDay: 10, tokensPerPeriod: 100, period: "week" }, path);
  expect(b.spend(500, t0)).toBeUndefined(); // one note larger than the budget cannot stall the queue
  expect(b.tokensLeft(t0)).toBe(0);
  const again = new DailyBudget({ newPerDay: 10, runsPerDay: 10, tokensPerPeriod: 100, period: "week" }, path);
  expect(again.spend(1, t0)).toMatchObject({ limit: "budget", kind: "tokens" });
  // The next ISO week starts Monday 19 October; the day counters reset daily without touching the week's tokens.
  expect(again.spend(1, Date.UTC(2026, 9, 18, 23))).toMatchObject({ kind: "tokens" });
  expect(again.take("runs", Date.UTC(2026, 9, 17))).toBeUndefined();
  expect(again.tokensLeft(Date.UTC(2026, 9, 17))).toBe(0);
  expect(again.spend(60, Date.UTC(2026, 9, 19))).toBeUndefined();
  expect(again.spend(50, Date.UTC(2026, 9, 19))).toMatchObject({ kind: "tokens" });
  // A refused spend closes the period: a smaller note later does not restart the drain.
  expect(again.tokensLeft(Date.UTC(2026, 9, 19))).toBe(0);
  expect(again.spend(40, Date.UTC(2026, 9, 19))).toMatchObject({ kind: "tokens" });
  expect(periodKey("week", Date.UTC(2026, 9, 16))).toBe("2026-W42");
  expect(periodKey("month", t0)).toBe("2026-10");
  expect(new Date(nextPeriod("week", t0)).toISOString().slice(0, 10)).toBe("2026-10-19");
  expect(new Date(nextPeriod("month", t0)).toISOString().slice(0, 10)).toBe("2026-11-01");
  expect(quarterKey(t0)).toBe("2026-Q4");
  // A budget of 0 stops extraction; an unreadable file refuses and reports nothing left.
  expect(new DailyBudget({ newPerDay: 1, runsPerDay: 1, tokensPerPeriod: 0 }, join(dir, "zero.json")).spend(1)).toMatchObject({ kind: "tokens" });
  writeFileSync(path, "{not json");
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(again.spend(1)).toMatchObject({ limit: "budget" });
  expect(again.tokensLeft()).toBe(0);
});

test("a refusal of one kind spends nothing of the other", () => {
  const b = new DailyBudget({ newPerDay: 0, runsPerDay: 1 }, join(dir, "b.json"));
  expect(b.take(["runs", "new"])).toMatchObject({ kind: "new" });
  expect(b.take("runs")).toBeUndefined();
});

test("with the period's tokens spent nothing starts, and the waiting job says why", () => {
  const service = new CoverageService(1, { limits: limits({ tokensPerPeriod: 0 }), admission: async () => ({ admit: true, why: "test" }) });
  try {
    const job = service.submit("pkg:npm/a");
    expect(job.state).toBe("queued");
    expect(job.stage).toMatch(/^Coverage budget for this day spent; continues after \d{4}-\d{2}-\d{2}$/);
  } finally {
    service.stop();
  }
});

test("over the daily count of new technologies, admitted work still runs", () => {
  const service = new CoverageService(1, { limits: limits({ newPerDay: 0 }), admission: async () => ({ admit: true, why: "test" }) });
  try {
    const fresh = service.submit("pkg:npm/new");
    expect(fresh.stage).toMatch(/^Daily limit of new technologies reached; continues after/);
  } finally {
    service.stop();
  }
});

// --- work(): mocked discovery, release index, synthesis and docs pass ---
async function mockWork(techs: Record<string, { repo: string; tags: string[]; size?: number }>) {
  const discovery = await import("../src/onboarding/discovery.ts");
  const fetching = await import("../src/pipeline/fetch.ts");
  const synthesis = await import("../src/onboarding/synthesis.ts");
  const docs = await import("../src/docs/extract.ts");
  const descriptor = (purl: string): PublicTechnology => ({
    discovery_version: discovery.DISCOVERY_VERSION,
    purl,
    id: purl.slice(8),
    name: purl.slice(8),
    latest: "1.0.0",
    repo: techs[purl]!.repo,
    tag: "^v(\\d+\\.\\d+\\.\\d+)$",
    components: [purl],
  });
  vi.spyOn(discovery, "discoverTechnology").mockImplementation(async (purl) => descriptor(purl));
  vi.spyOn(fetching, "fetchReleases").mockImplementation(async (t) => {
    const spec = techs[t.components[0]!]!;
    return {
      checked: new Date().toISOString(),
      stats: { requests: 0, newReleases: 0 },
      notes: spec.tags.map((tag, i) => ({
        technology: t.id,
        tag,
        version: tag.replace(/^v/, ""),
        date: "2026-10-01",
        url: `https://github.com/${spec.repo}/releases/tag/${tag}`,
        snapshot: "sha256:" + String(i).padStart(64, "0"),
        notes: "x".repeat((spec.size ?? 10) * 4),
      })),
    };
  });
  const synth = vi.spyOn(synthesis, "synthesize").mockResolvedValue(1);
  vi.spyOn(docs, "dailyPass").mockResolvedValue(undefined as never);
  vi.spyOn(docs, "extract").mockResolvedValue({} as never);
  return { synth };
}

test("past its quarterly cap a technology's remaining notes wait behind other technologies", async () => {
  const { synth } = await mockWork({
    "pkg:npm/verbose": { repo: "ex/verbose", tags: ["v1.0.3", "v1.0.2", "v1.0.1"], size: 60 },
    "pkg:npm/light": { repo: "ex/light", tags: ["v2.0.0"], size: 10 },
  });
  const service = new CoverageService(1, { advisories: false, limits: limits({ techQuarterTokens: 100 }), admission: async () => ({ admit: true, why: "test" }) });
  try {
    service.submit("pkg:npm/verbose");
    service.submit("pkg:npm/light");
    await vi.waitFor(() => expect(service.jobs.get("pkg:npm/verbose")?.state).toBe("monitoring"), { timeout: 3000 });
    await vi.waitFor(() => expect(service.jobs.get("pkg:npm/light")?.state).toBe("monitoring"), { timeout: 3000 });
    // The first note of the quarter passes; the second would pass the cap, so the light technology goes first and
    // the verbose one's remaining notes drain afterwards, past its cap, from the period's budget.
    expect(synth.mock.calls.map(([t]) => t.id)).toEqual(["verbose", "light", "verbose", "verbose"]);
    const job = service.jobs.get("pkg:npm/verbose")!;
    expect(job.overflow).toBe(quarterKey());
    expect(job.quarter).toEqual({ key: quarterKey(), tokens: 180 });
  } finally {
    service.stop();
  }
});

test("type stubs join the technology of the package they type when it is covered, and are parked otherwise", async () => {
  await mockWork({ "pkg:npm/lib": { repo: "ex/lib", tags: ["v1.0.0", "v0.9.0"] }, "pkg:npm/%40types/lib": { repo: "DefinitelyTyped/DefinitelyTyped", tags: [] }, "pkg:npm/%40types/gone": { repo: "DefinitelyTyped/DefinitelyTyped", tags: [] } });
  const service = new CoverageService(1, {
    advisories: false,
    limits: limits(),
    admission: async (purl) => (purl.includes("types") ? { admit: false, why: "type stubs", rule: "types", typesFor: purl.endsWith("lib") ? "lib" : "gone" } : { admit: true, why: "test" }),
  });
  try {
    service.submit("pkg:npm/lib");
    await vi.waitFor(() => expect(service.jobs.get("pkg:npm/lib")?.state).toBe("monitoring"), { timeout: 3000 });
    service.submit("pkg:npm/%40types/lib");
    service.submit("pkg:npm/%40types/gone");
    await vi.waitFor(() => expect(service.jobs.get("pkg:npm/%40types/lib")?.merged_into).toBe("pkg:npm/lib"), { timeout: 3000 });
    expect(service.jobs.get("pkg:npm/lib")?.descriptor?.components).toContain("pkg:npm/%40types/lib");
    await vi.waitFor(() => expect(service.jobs.get("pkg:npm/%40types/gone")?.state).toBe("blocked"), { timeout: 3000 });
  } finally {
    service.stop();
  }
});

test("the period's token budget is spent per note and a spent budget parks extraction until the next period", async () => {
  const { synth } = await mockWork({ "pkg:npm/a": { repo: "ex/a", tags: ["v1.0.2", "v1.0.1"], size: 60 } });
  const service = new CoverageService(1, { advisories: false, limits: limits({ tokensPerPeriod: 100 }), admission: async () => ({ admit: true, why: "test" }) });
  try {
    service.submit("pkg:npm/a");
    await vi.waitFor(() => expect(service.jobs.get("pkg:npm/a")?.stage).toMatch(/coverage budget for this day spent/i), { timeout: 3000 });
    // Not restarted while the period lasts.
    await new Promise((r) => setTimeout(r, 50));
    expect(synth).toHaveBeenCalledTimes(1);
    expect(service.jobs.get("pkg:npm/a")?.state).toBe("queued");
  } finally {
    service.stop();
  }
});

test("one repository and release stream is one technology: a second package joins the first instead of extracting again", async () => {
  const tags = ["v2.1.0", "v2.0.0", "v1.9.0"];
  const { synth } = await mockWork({
    "pkg:npm/core": { repo: "ex/mono", tags },
    "pkg:npm/addon": { repo: "Ex/Mono", tags },
    "pkg:npm/other": { repo: "ex/mono", tags: ["other@1.0.0", "other@0.9.0"] },
  });
  const service = new CoverageService(1, { advisories: false, limits: limits(), admission: async () => ({ admit: true, why: "test" }) });
  try {
    service.register("pkg:npm/core", "198.51.100.1");
    await vi.waitFor(() => expect(service.jobs.get("pkg:npm/core")?.state).toBe("monitoring"), { timeout: 3000 });
    expect(synth).toHaveBeenCalledTimes(3);
    service.register("pkg:npm/addon", "198.51.100.2");
    await vi.waitFor(() => expect(service.jobs.get("pkg:npm/addon")?.merged_into).toBe("pkg:npm/core"), { timeout: 3000 });
    const addon = service.jobs.get("pkg:npm/addon")!;
    const core = service.jobs.get("pkg:npm/core")!;
    expect(addon).toMatchObject({ state: "monitoring", technology: "core" });
    expect(addon.stage).toContain("Covered as part of core");
    expect(core.descriptor?.components).toEqual(["pkg:npm/core", "pkg:npm/addon"]);
    expect(core.siblings).toEqual(["pkg:npm/addon"]);
    expect(core.demand).toBe(2);
    expect(synth).toHaveBeenCalledTimes(3); // nothing extracted twice
    // A vote for the joined package counts for its technology.
    service.register("pkg:npm/addon", "198.51.100.3");
    expect(core.demand).toBe(3);
    // The served index names both packages, whichever job is found first.
    const body = Buffer.from(JSON.stringify({ schema: 1 }));
    expect(JSON.parse(servedIndex(body, "core", [addon, core]).toString()).components).toEqual(["pkg:npm/core", "pkg:npm/addon"]);
    // A package of the same repository with its own tag stream stays its own technology.
    service.register("pkg:npm/other", "198.51.100.4");
    await vi.waitFor(() => expect(service.jobs.get("pkg:npm/other")?.state).toBe("monitoring"), { timeout: 3000 });
    expect(service.jobs.get("pkg:npm/other")?.merged_into).toBeUndefined();
    expect(synth).toHaveBeenCalledTimes(5);
    // A refresh of the host rediscovers it and keeps its siblings.
    core.retry_at = "2020-01-01T00:00:00Z";
    (service as unknown as { pump: () => void }).pump();
    await vi.waitFor(() => expect(core.state).toBe("monitoring"), { timeout: 3000 });
    expect(core.descriptor?.components).toEqual(["pkg:npm/core", "pkg:npm/addon"]);
  } finally {
    service.stop();
  }
});

test("release streams: shared bare tags match; per-package tags or too few tags do not", () => {
  const ten = Array.from({ length: 10 }, (_, i) => `v1.${i}.0`);
  // Fetched at different times: one side has a newer release.
  expect(sameStream(ten, ["v1.10.0", ...ten.slice(0, 9)])).toBe(true);
  expect(sameStream(["a@1.0.0", "a@0.9.0"], ["b@1.0.0", "b@0.9.0"])).toBe(false);
  expect(sameStream(["v1.0.0"], ["v1.0.0"])).toBe(false);
  expect(sameStream(["v1", "v2", "v3", "v4", "v5"], ["v1", "v2", "x", "y", "z"])).toBe(false);
});

test("a deprecated package is parked after one deprecation record is published", async () => {
  await mockWork({ "pkg:npm/old-lib": { repo: "ex/old-lib", tags: ["v1.0.0", "v0.9.0"] } });
  const { loadStore } = await import("../src/pipeline/store.ts");
  const verdict = { admit: false as const, why: "deprecated by its registry", rule: "deprecated" as const, notice: { kind: "deprecated" as const, message: "Use new-lib instead." } };
  const service = new CoverageService(1, { advisories: false, limits: limits(), admission: async () => verdict });
  try {
    service.submit("pkg:npm/old-lib");
    await vi.waitFor(() => expect(service.jobs.get("pkg:npm/old-lib")?.state).toBe("blocked"), { timeout: 3000 });
    const records = Object.values(loadStore("old-lib").records);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ change_type: "deprecation", breaking: false, subject: "old-lib" });
    expect(records[0]!.evidence[0]).toMatchObject({ kind: "other", url: "https://www.npmjs.com/package/old-lib", quote: "Use new-lib instead." });
    expect(records[0]!.classifier).toBeUndefined();
    const job: Job = service.jobs.get("pkg:npm/old-lib")!;
    expect(job.deprecation_notice).toBeDefined();
    // The next admission check (a week later) does not publish it again.
    delete job.deprecation_notice;
    job.retry_at = "2020-01-01T00:00:00Z";
    (service as unknown as { pump: () => void }).pump();
    await vi.waitFor(() => expect(job.deprecation_notice).toBeDefined(), { timeout: 3000 });
    expect(Object.values(loadStore("old-lib").records)).toHaveLength(1);
  } finally {
    service.stop();
  }
});

test("the deprecation notice is read from either verdict shape and absent otherwise", () => {
  expect(deprecationOf({ admit: false, why: "w", notice: "deprecated", message: "m" } as never)).toBe("m");
  expect(deprecationOf({ admit: false, why: "w", notice: { kind: "deprecated", message: "n" } } as never)).toBe("n");
  expect(deprecationOf({ admit: false, why: "w", notice: "deprecated" } as never)).toBe("w");
  expect(deprecationOf({ admit: true, why: "w" })).toBeUndefined();
});
