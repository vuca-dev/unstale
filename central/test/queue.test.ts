// The admission queue: votes by distinct requesters, drain order by tier then demand with no aging (adoption breaks
// ties among new technologies), the release-note token budget per period (persisted, fails closed), the per-technology
// quarterly cap, the technology unit (one repository and release stream) and the deprecation notice.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { FetchFailure } from "../src/collector/http.ts";
import { CoverageService, logName, REFRESH_MS, sameStream, type Job } from "../src/onboarding/service.ts";
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
  votesPerAddressPerHour: 1000,
  runsPerDay: 100,
  trustProxy: 0,
  tokensPerPeriod: 1_000_000,
  period: "day",
  techQuarterTokens: 50_000,
  ...l,
});

test("a request for a queued technology is a vote: one per requester, within its own address limit, persisted as a count", () => {
  const service = new CoverageService(0, { limits: limits({ perAddressPerHour: 3, votesPerAddressPerHour: 2 }) });
  service.register("pkg:npm/a", "198.51.100.1");
  service.register("pkg:npm/a", "198.51.100.1");
  service.register("pkg:npm/a", "198.51.100.2");
  expect(service.jobs.get("pkg:npm/a")?.demand).toBe(2);
  // Over the vote limit the answer is the same job, but the vote does not count.
  service.register("pkg:npm/b", "198.51.100.4");
  service.register("pkg:npm/c", "198.51.100.4");
  service.register("pkg:npm/b", "198.51.100.3");
  service.register("pkg:npm/c", "198.51.100.3");
  expect(service.register("pkg:npm/a", "198.51.100.3")).toMatchObject({ purl: "pkg:npm/a" });
  expect(service.jobs.get("pkg:npm/a")?.demand).toBe(2);
  // Votes are a bucket apart: the address that spent its votes still registers new technologies.
  for (const p of ["d", "e", "f"]) expect(service.register(`pkg:npm/${p}`, "198.51.100.3")).toMatchObject({ purl: `pkg:npm/${p}` });
  expect(service.register("pkg:npm/g", "198.51.100.3")).toMatchObject({ limit: "address" });
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
  // Its releases read in its last slice: no check due, only its remaining history waits, behind everything.
  overflow.refresh_checked = new Date().toISOString();
  const parked = service.submit("pkg:npm/parked");
  parked.state = "blocked";
  parked.retry_at = new Date(Date.now() + 86_400_000).toISOString();
  expect(service.queue().map((j) => j.purl.slice(8))).toEqual(["continuing", "popular", "middle", "tie", "old", "overflow"]);
  // A quarter later the cap has reset: the overflowing technology is ordinary admitted work again.
  overflow.overflow = "2000-Q1";
  expect(service.queue()[0]!.purl).toBe("pkg:npm/overflow");
  // A place is in the job's line: a new technology waits only behind new ones (admitted work has its own slots).
  const status = service.publicStatus(middle);
  expect(status).toMatchObject({ queue_position: 2, queue_length: 4 });
  expect(status.stage).toBe("Waiting for a coverage worker (position 2 of 4 new technologies)");
  expect(service.publicStatus(continuing)).toMatchObject({ queue_position: 2, queue_length: 2 });
  expect(status).not.toHaveProperty("demand_voters");
  // The requester count orders the queue but is never published: the coverage files would tell how many use a package.
  expect(status).not.toHaveProperty("demand");
  expect(service.statuses().filter((s) => "demand" in s)).toEqual([]);
  expect(service.publicStatus(parked)).not.toHaveProperty("queue_position");
});

test("the public run logs name a requested package only once it is admitted; before, a hash prefix stands for it", () => {
  const purl = "pkg:npm/someones-internal-name";
  const hidden = logName({ purl });
  expect(hidden).toMatch(/^requested package [0-9a-f]{12}$/);
  expect(hidden).not.toContain("someones");
  expect(logName({ purl, admitted: "maintained and used" })).toBe(purl);
});

test("among new technologies of equal demand the most adopted drain first; an unreadable count is 0, read once per process", async () => {
  const asked: string[][] = [];
  const adoption = async (purls: string[]) => {
    asked.push(purls);
    return new Map([["pkg:npm/big", 5_000_000], ["pkg:pypi/mid", 40_000], ["pkg:npm/admitted", 9e9]]);
  };
  const service = new CoverageService(0, { limits: limits(), adoption });
  for (const p of ["pkg:npm/unread", "pkg:pypi/mid", "pkg:npm/big", "pkg:npm/wanted", "pkg:npm/admitted"]) service.submit(p).demand = 1;
  service.jobs.get("pkg:npm/wanted")!.demand = 2;
  service.jobs.get("pkg:npm/admitted")!.admitted = "maintained and used";
  await service.readAdoption();
  expect(asked).toEqual([["pkg:npm/unread", "pkg:pypi/mid", "pkg:npm/big", "pkg:npm/wanted"]]);
  // Demand stays the first key; adoption only orders equal demand; admitted work is not reordered by it.
  expect(service.queue().map((j) => j.purl)).toEqual(["pkg:npm/admitted", "pkg:npm/wanted", "pkg:npm/big", "pkg:pypi/mid", "pkg:npm/unread"]);
  expect(service.publicStatus(service.jobs.get("pkg:npm/big")!)).not.toHaveProperty("downloads");
  // Persisted; an unread count is not asked for again by this process, but is by the next.
  await service.readAdoption();
  expect(asked).toHaveLength(1);
  const restarted = new CoverageService(0, { limits: limits(), adoption });
  expect(restarted.jobs.get("pkg:npm/big")?.downloads).toBe(5_000_000);
  await restarted.readAdoption();
  expect(asked[1]).toContain("pkg:npm/unread");
  expect(asked[1]).not.toContain("pkg:npm/big");
  expect(asked[1]).not.toContain("pkg:pypi/mid");
  // A failing reader leaves the order by demand and arrival.
  const failing = new CoverageService(0, { limits: limits(), adoption: async () => Promise.reject(new Error("down")) });
  await failing.readAdoption();
  expect(failing.jobs.get("pkg:npm/unread")?.downloads).toBeUndefined();
  // A reader slower than the timeout is not waited for.
  const slow = new CoverageService(0, { limits: limits(), adoption: () => new Promise(() => {}) });
  await slow.readAdoption(10);
  expect(slow.jobs.get("pkg:npm/unread")?.downloads).toBeUndefined();
});

test("token budget per period: spent per note, persisted, reset each period, first spend always passes, fails closed", () => {
  const path = join(dir, "budget.json");
  const t0 = Date.UTC(2026, 9, 16, 12);
  const b = new DailyBudget({ runsPerDay: 10, tokensPerPeriod: 100, period: "week" }, path);
  expect(b.spend(500, t0)).toBeUndefined(); // one note larger than the budget cannot stall the queue
  expect(b.tokensLeft(t0)).toBe(0);
  const again = new DailyBudget({ runsPerDay: 10, tokensPerPeriod: 100, period: "week" }, path);
  expect(again.spend(1, t0)).toMatchObject({ limit: "budget", kind: "tokens" });
  // The next ISO week starts Monday 19 October; the day counters reset daily without touching the week's tokens.
  expect(again.spend(1, Date.UTC(2026, 9, 18, 23))).toMatchObject({ kind: "tokens" });
  expect(again.takeRun(Date.UTC(2026, 9, 17))).toBeUndefined();
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
  expect(new DailyBudget({ runsPerDay: 1, tokensPerPeriod: 0 }, join(dir, "zero.json")).spend(1)).toMatchObject({ kind: "tokens" });
  writeFileSync(path, "{not json");
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(again.spend(1)).toMatchObject({ limit: "budget" });
  expect(again.tokensLeft()).toBe(0);
});

test("the spent limits name their cap and reset: tokens at the period's end, counts at the next UTC day", () => {
  const now = Date.parse("2026-10-17T14:51:00Z");
  const b = new DailyBudget({ runsPerDay: 1, tokensPerPeriod: 100, period: "week" }, join(dir, "spent.json"));
  expect(b.spent(now)).toEqual([]);
  expect(b.takeRun(now)).toBeUndefined();
  expect(b.spent(now)).toEqual([{ limit: "runs_per_day", cap: 1, resets: "2026-10-18T00:00:00.000Z" }]);
  b.spend(80, now);
  expect(b.spend(30, now)).toMatchObject({ kind: "tokens" });
  expect(b.spent(now).map((h) => [h.limit, h.cap, h.resets])).toEqual([
    ["tokens", 100, "2026-10-19T00:00:00.000Z"],
    ["runs_per_day", 1, "2026-10-18T00:00:00.000Z"],
  ]);
  writeFileSync(join(dir, "spent.json"), "{");
  expect(b.spent(now)).toEqual([{ limit: "unreadable" }]);
});

test("without a run cap runs are not counted and nothing is spent; a file left with a count of new technologies still reads", () => {
  const path = join(dir, "b.json");
  const now = Date.parse("2026-10-17T14:51:00Z");
  const day = "2026-10-17";
  writeFileSync(path, JSON.stringify({ day, new: 100, runs: 3 }));
  const b = new DailyBudget({}, path);
  for (let i = 0; i < 1500; i++) expect(b.takeRun(now)).toBeUndefined();
  expect(b.spent(now)).toEqual([]);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ day, new: 100, runs: 3 });
  expect(new DailyBudget({ runsPerDay: 4 }, path).takeRun(now)).toBeUndefined();
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ day, runs: 4, period: day, tokens: 0 });
  expect(new DailyBudget({ runsPerDay: 4 }, path).takeRun(now)).toMatchObject({ kind: "runs" });
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
  vi.spyOn(fetching, "fetchGuides").mockResolvedValue([]);
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
    // Its public status carries the technology's counters, not its own zeros (which a client would read as a gap).
    const status = service.statuses().find((s) => s.purl === "pkg:npm/addon")!;
    expect([status.records, status.releases_total]).toEqual([core.records, core.releases_total]);
    expect(core.releases_total).toBe(3);
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

test("a monitored technology's upgrade guide is extracted once, charged like a note", async () => {
  const { synth } = await mockWork({ "pkg:npm/mui": { repo: "ex/mui", tags: ["v9.1.0"] } });
  const fetching = await import("../src/pipeline/fetch.ts");
  const guide = {
    technology: "mui",
    kind: "upgrade_guide" as const,
    tag: "guide-9",
    keyTag: "+guide.0123abcd",
    version: "9.0.0",
    date: "2026-04-08",
    url: "https://mui.com/material-ui/migration/upgrade-to-v9/",
    snapshot: "sha256:0123abcd" + "0".repeat(56),
    notes: "## Removed `FormHelperTextProps`\n\nUse `slotProps.formHelperText` instead.",
  };
  const guides = vi.spyOn(fetching, "fetchGuides").mockResolvedValue([guide]);
  const service = new CoverageService(1, { advisories: false, limits: limits(), admission: async () => ({ admit: true, why: "test" }) });
  try {
    service.register("pkg:npm/mui", "198.51.100.1");
    await vi.waitFor(() => expect(service.jobs.get("pkg:npm/mui")?.state).toBe("monitoring"), { timeout: 3000 });
    const job = service.jobs.get("pkg:npm/mui")!;
    expect(synth.mock.calls.map(([, n]) => n.tag)).toEqual(["v9.1.0", "guide-9"]);
    expect(job.guides_done).toEqual(["+guide.0123abcd:audience-v1"]);
    expect(guides).toHaveBeenCalledWith(expect.objectContaining({ id: "mui" }), expect.any(Array), expect.objectContaining({ checked: true }));
    expect(service.statuses().find((s) => s.purl === "pkg:npm/mui")).not.toHaveProperty("guides_done");
  } finally {
    service.stop();
  }
});

test("bounded registry polling promotes changes, rotates attempts and leaves full security refreshes due", async () => {
  const service = new CoverageService(0, { limits: limits() }).hold();
  const add = (name: string) => {
    const job = service.submit(`pkg:npm/${name}`);
    job.state = "monitoring";
    job.monitored = "2026-01-01T00:00:00Z";
    job.descriptor = { purl: job.purl, id: job.technology, name, latest: "1.0.0", tag: "", components: [job.purl] };
    job.retry_at = new Date(Date.now() + 6 * 3600_000).toISOString();
    return job;
  };
  const paused = add("paused");
  paused.paused_until = new Date(Date.now() + 3600_000).toISOString();
  const changed = add("changed"), unchanged = add("unchanged"), failed = add("failed");
  const read = vi.fn(async (purl: string) => purl.endsWith("changed") && !purl.endsWith("unchanged") ? "2.0.0" : "1.0.0");
  expect(await service.pollChanges({ limit: 2, read })).toEqual({ attempted: 2, checked: 2, changed: 1 });
  expect(read.mock.calls.map(([purl]) => purl)).toEqual([changed.purl, unchanged.purl]);
  expect(paused.registry_polled).toBeUndefined();
  expect(changed.change_detected).toBeDefined();
  expect(service.queue()[0]?.purl).toBe(changed.purl);
  expect(unchanged.change_detected).toBeUndefined();
  const refreshAt = unchanged.retry_at;
  expect(await service.pollChanges({ limit: 1, read: async (purl) => { expect(purl).toBe(failed.purl); throw new Error("429"); } }))
    .toEqual({ attempted: 1, checked: 0, changed: 0 });
  expect(unchanged.retry_at).toBe(refreshAt);
  expect(failed.registry_version).toBeUndefined();
  expect(failed.change_detected).toBeUndefined();
  const restored = new CoverageService(0, { limits: limits() });
  expect(restored.jobs.get(changed.purl)?.change_detected).toBe(changed.change_detected);
  const publicStatus = restored.publicStatus(restored.jobs.get(changed.purl)!);
  expect(publicStatus).not.toHaveProperty("registry_version");
  expect(publicStatus).not.toHaveProperty("change_detected");
});

test("one worker starts the oldest overdue refresh ahead of popular historical backfill", async () => {
  const service = new CoverageService(1, { limits: limits() }).hold();
  const backlog = service.submit("pkg:npm/backlog");
  backlog.admitted = "used";
  backlog.demand = 1000;
  const refresh = service.submit("pkg:npm/refresh");
  refresh.state = "monitoring";
  refresh.admitted = "used";
  refresh.retry_at = "2020-01-01T00:00:00Z";
  const started: string[] = [];
  vi.spyOn(service as unknown as { work(job: Job): Promise<void> }, "work").mockImplementation(async (job) => {
    started.push(job.purl);
    job.state = "monitoring";
    job.retry_at = new Date(Date.now() + 6 * 3600_000).toISOString();
  });
  await service.drain(Date.now() + 1000, 0, 1);
  expect(started).toEqual([refresh.purl, backlog.purl]);
});

test("freshness counts unique monitored jobs and reports missing upstream evidence explicitly", () => {
  const service = new CoverageService(0, { limits: limits() });
  const at = Date.now();
  for (const [name, hours] of [["fresh", 1], ["stale", 10], ["unknown", undefined]] as const) {
    const job = service.submit(`pkg:npm/${name}`);
    job.state = "monitoring";
    if (hours !== undefined) job.release_checked = new Date(at - hours * 3600_000).toISOString();
  }
  expect(service.freshness(at)).toMatchObject({ monitored: 3, release_check_unknown: 1,
    release_check_age_s: { p50: 3600, p95: 36000, max: 36000 }, release_checks_over_6h: 1 });
});


test("a registry rate limit stops polling across cycles without pausing the indexing queue", async () => {
  const service = new CoverageService(0, { limits: limits() }).hold();
  for (const name of ["a", "b", "c", "d"]) {
    const job = service.submit(`pkg:npm/${name}`);
    job.state = "monitoring";
    job.descriptor = { purl: job.purl, id: job.technology, name, latest: "1.0.0", tag: "", components: [job.purl] };
    job.retry_at = "2020-01-01T00:00:00Z";
  }
  const read = vi.fn(async () => { throw new FetchFailure("http_status", "HTTP 429", 429, 3600_000); });
  const result = await service.pollChanges({ read });
  expect(result.attempted).toBeLessThanOrEqual(2);
  expect(result.checked).toBe(0);
  expect(service.queue()).toHaveLength(4);
  const restarted = new CoverageService(0, { limits: limits() }).hold();
  const paused = await restarted.pollChanges({ read });
  expect(paused.attempted).toBe(0);
  expect(Date.parse(paused.paused_until!)).toBeGreaterThan(Date.now() + 3500_000);
  expect(read.mock.calls.length).toBeLessThanOrEqual(2);
});

test("a monitored technology past its quarterly cap is still checked for new releases on time, and that check extracts no note", async () => {
  const service = new CoverageService(1, { limits: limits() }).hold();
  const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
  const admitted = (name: string) => {
    const job = service.submit(`pkg:npm/${name}`);
    job.admitted = "used";
    return job;
  };
  const backlog = admitted("backlog");
  backlog.demand = 1000;
  // Past its cap with history left (requeued by its last slice), last checked a day ago: its refresh is due.
  const capped = admitted("capped");
  Object.assign(capped, { monitored: ago(48), overflow: quarterKey(), refresh_checked: ago(24), completed: ["v1:x:audience-v1"] });
  // Past its cap and checked an hour ago: only its remaining history waits, behind every other technology.
  const checked = admitted("checked");
  Object.assign(checked, { monitored: ago(48), overflow: quarterKey(), refresh_checked: ago(1), completed: ["v1:x:audience-v1"] });
  // Admitted, past its cap before its first coverage finished (never monitored), releases last read 60 hours ago.
  const first = admitted("first");
  Object.assign(first, { overflow: quarterKey(), completed: ["v1:x:audience-v1"], release_checked: ago(60), refresh_checked: ago(30) });
  const fresh = service.submit("pkg:npm/new");
  fresh.demand = 50;
  expect(service.queue().map((j) => j.purl.slice(8))).toEqual(["backlog", "capped", "first", "new", "checked"]);
  const started: string[] = [];
  vi.spyOn(service as unknown as { work(job: Job): Promise<void> }, "work").mockImplementation(async (job) => {
    started.push(job.purl.slice(8));
    job.state = "monitoring";
    job.retry_at = new Date(Date.now() + 6 * 3600_000).toISOString();
  });
  await service.drain(Date.now() + 1000, 0, 1);
  // The kept slot takes the due checks by their last upstream read (first: 60 h, capped: 48 h), then demand order.
  expect(started).toEqual(["first", "capped", "backlog", "new", "checked"]);
  // The stamp orders the line; it is never public.
  expect(service.publicStatus(capped)).not.toHaveProperty("refresh_checked");
  expect(service.statuses().filter((x) => "refresh_checked" in x)).toEqual([]);
});

test("the release check of a technology past its cap reads its releases without extracting; its history then drains behind", async () => {
  const { synth } = await mockWork({ "pkg:npm/verbose": { repo: "ex/verbose", tags: ["v1.0.3", "v1.0.2", "v1.0.1"], size: 60 } });
  const fetching = await import("../src/pipeline/fetch.ts");
  const events: string[] = [];
  const read = vi.mocked(fetching.fetchReleases).getMockImplementation()!;
  // Every read comes from the 12-hour cache, last refreshed upstream 10 hours ago.
  const cached = new Date(Date.now() - 10 * 3600_000).toISOString();
  vi.mocked(fetching.fetchReleases).mockImplementation(async (...a) => (events.push("releases"), { ...(await read(...a)), checked: cached }));
  synth.mockImplementation(async () => (events.push("synthesize"), 1));
  const service = new CoverageService(1, { advisories: false, limits: limits({ techQuarterTokens: 100 }), admission: async () => ({ admit: true, why: "test" }) }).hold();
  const job = service.submit("pkg:npm/verbose");
  const day = new Date(Date.now() - 86_400_000).toISOString();
  Object.assign(job, { admitted: "used", monitored: day, refresh_checked: day, overflow: quarterKey(), quarter: { key: quarterKey(), tokens: 200 } });
  await service.drain(Date.now() + 2000, 0, 1);
  // First the due check (releases read, no note extracted), then the history, as tier 2 work from the period's budget:
  // a read from the cache counts toward the interval, so the check does not run again at once.
  expect(events.slice(0, 3)).toEqual(["releases", "releases", "synthesize"]);
  expect(Date.parse(job.refresh_checked!)).toBeGreaterThan(Date.parse(day));
  // The order of due checks keeps the upstream read, not the cached one's time.
  expect(job.release_checked).toBe(cached);
});

test("a release check past the cap makes no model call and spends no token, and starts under a spent budget", async () => {
  const tags = ["v1.0.2", "v1.0.1"];
  const { synth } = await mockWork({
    "pkg:npm/verbose": { repo: "ex/verbose", tags, size: 60 },
    "pkg:npm/backlog": { repo: "ex/backlog", tags: ["v2.0.0"] },
  });
  const fetching = await import("../src/pipeline/fetch.ts");
  const docs = await import("../src/docs/extract.ts");
  const match = await import("../src/pipeline/match.ts");
  vi.mocked(fetching.fetchGuides).mockResolvedValue([{ keyTag: "guide-v1", version: "1.0.0", notes: "y".repeat(400) }] as never);
  const admitted: boolean[] = [];
  vi.mocked(docs.extract).mockImplementation(async (_t, _l, _log, admit) => (admitted.push(admit!("z".repeat(400))), {} as never));
  const judge = vi.spyOn(match, "mergeChunkDuplicates");
  const read = vi.spyOn(fetching, "fetchReleases");
  const advisories = await import("../src/pipeline/advisories.ts");
  vi.spyOn(fetching, "advisoryReleases").mockResolvedValue([{}] as never);
  const judgeAdvisories = vi.spyOn(advisories, "advisoryStage").mockResolvedValue(undefined as never);
  const service = new CoverageService(1, { limits: limits({ techQuarterTokens: 100, tokensPerPeriod: 0 }), admission: async () => ({ admit: true, why: "test" }) }).hold();
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const job = service.submit("pkg:npm/verbose");
  Object.assign(job, { state: "monitoring", admitted: "used", monitored: day, release_checked: day, retry_at: day, overflow: quarterKey(),
    quarter: { key: quarterKey(), tokens: 200 }, completed: tags.map((t, i) => `${t}:sha256:${String(i).padStart(64, "0")}:audience-v1`) });
  const backlog = service.submit("pkg:npm/backlog");
  Object.assign(backlog, { admitted: "used", demand: 1000 });
  await service.drain(Date.now() + 2000, 0, 1);
  expect(read.mock.calls.map(([t]) => t.id)).toEqual(["verbose"]);
  expect(job.state).toBe("monitoring");
  expect(job.quarter).toEqual({ key: quarterKey(), tokens: 200 });
  expect(synth).not.toHaveBeenCalled();
  expect(judge).not.toHaveBeenCalled();
  expect(judgeAdvisories).not.toHaveBeenCalled();
  expect(admitted).toEqual([false]);
  // Work that may call a model still waits for the next period.
  expect(backlog.state).toBe("queued");
  expect(backlog.stage).toMatch(/coverage budget for this day spent/i);
});

test("while a popular refresh runs, the oldest-checked due refresh (by its upstream read) still takes the next slot", async () => {
  const service = new CoverageService(2, { limits: limits() }).hold();
  const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
  const monitored = (name: string, demand: number, hours: number, retry: number) => {
    const job = service.submit(`pkg:npm/${name}`);
    Object.assign(job, { state: "monitoring", admitted: "used", demand, release_checked: ago(hours), retry_at: ago(retry) });
    return job;
  };
  // Due in the opposite order to their last check (a failure backoff, a change detected): the check decides.
  monitored("popular", 100, 7, 1);
  // Read from the cache an hour ago, but last read upstream 72 hours ago: still the oldest check.
  monitored("oldest", 0, 72, 0.2).refresh_checked = ago(1);
  monitored("recent", 5, 24, 5);
  monitored("older", 0, 48, 3);
  const started: string[] = [];
  vi.spyOn(service as unknown as { work(job: Job): Promise<void> }, "work").mockImplementation(async (job) => {
    started.push(job.purl.slice(8));
    if (job.purl.endsWith("popular")) await new Promise((r) => setTimeout(r, 100));
    job.state = "monitoring";
    job.retry_at = new Date(Date.now() + 6 * 3600_000).toISOString();
  });
  await service.drain(Date.now() + 1000, 0, 1);
  expect(started).toEqual(["oldest", "popular", "older", "recent"]);
});

test("the refresh interval is 12 hours: a finished refresh is due 12 hours on, a yielded one 12 hours after its read; a detected version is due at once", async () => {
  expect(REFRESH_MS).toBe(12 * 3600_000);
  await mockWork({ "pkg:npm/twelve": { repo: "ex/twelve", tags: ["v1.0.0"] } });
  const service = new CoverageService(1, { advisories: false, limits: limits(), admission: async () => ({ admit: true, why: "test" }) }).hold();
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const job = service.submit("pkg:npm/twelve");
  Object.assign(job, { state: "monitoring", admitted: "used", monitored: day, release_checked: day, retry_at: day,
    completed: ["v1.0.0:sha256:" + "0".repeat(64) + ":audience-v1"] });
  const before = Date.now();
  await service.drain(Date.now() + 2000, 0, 1);
  expect(job.state).toBe("monitoring");
  expect(Date.parse(job.retry_at!) - before).toBeGreaterThanOrEqual(12 * 3600_000);
  expect(Date.parse(job.retry_at!) - Date.now()).toBeLessThanOrEqual(12 * 3600_000);
  // A refresh that yielded (queued) is due by its last read: not 8 hours on, 13 hours on.
  const ago = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
  const yielded = (name: string, hours: number) =>
    Object.assign(service.submit(`pkg:npm/${name}`), { state: "queued", admitted: "used", monitored: day, refresh_checked: ago(hours), completed: ["v1:x:audience-v1"] });
  const recent = yielded("eight", 8), old = yielded("thirteen", 13);
  const due = (j: Job) => (service as unknown as { refreshDue(job: Job): boolean }).refreshDue(j);
  expect([due(recent), due(old)]).toEqual([false, true]);
  // The next cycle's registry poll sees a new version: the technology is due now, whatever its retry time.
  const next = new CoverageService(0, { limits: limits() }).hold();
  const polled = next.jobs.get("pkg:npm/twelve")!;
  expect(Date.parse(polled.retry_at!)).toBeGreaterThan(Date.now() + 11 * 3600_000);
  expect(await next.pollChanges({ read: async (purl) => (purl === polled.purl ? "1.1.0" : "1.0.0") })).toMatchObject({ changed: 1 });
  expect(Date.parse(polled.retry_at!)).toBeLessThanOrEqual(Date.now());
  expect(next.queue()[0]?.purl).toBe(polled.purl);
});

test("the failure estimate and the interval's past-due count follow the 12-hour interval", () => {
  const service = new CoverageService(0, { limits: limits() });
  const at = Date.now();
  const ago = (hours: number) => new Date(at - hours * 3600_000).toISOString();
  for (const [name, hours] of [["eight", 8], ["thirteen", 13]] as const) {
    const job = service.submit(`pkg:npm/${name}`);
    // Failed since its last read, saved long after it.
    Object.assign(job, { state: "monitoring", admitted: "used", descriptor: { repo: `ex/${name}` }, release_checked: ago(hours), refresh_checked: ago(hours),
      retry_at: ago(0.1), failures: 1, updated: ago(0.5) });
  }
  expect(service.freshness(at)).toMatchObject({ unimprovable: { failing_before_read_estimate: 1 } });
  expect((service as unknown as { dueRefreshes(at?: number): { overdue: number } }).dueRefreshes(at).overdue).toBe(1);
});

test("a due refresh under its cap is no release check: it extracts, judges advisories and charges its tokens", async () => {
  const tags = ["v1.0.2", "v1.0.1"];
  const { synth } = await mockWork({ "pkg:npm/light": { repo: "ex/light", tags, size: 10 } });
  const fetching = await import("../src/pipeline/fetch.ts");
  const advisories = await import("../src/pipeline/advisories.ts");
  vi.spyOn(fetching, "advisoryReleases").mockResolvedValue([{}] as never);
  const judgeAdvisories = vi.spyOn(advisories, "advisoryStage").mockResolvedValue(undefined as never);
  const service = new CoverageService(1, { limits: limits({ techQuarterTokens: 100 }), admission: async () => ({ admit: true, why: "test" }) }).hold();
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const job = service.submit("pkg:npm/light");
  // One release read before; the newer one is new. 20 of 100 tokens used this quarter.
  Object.assign(job, { state: "monitoring", admitted: "used", monitored: day, release_checked: day, retry_at: day,
    quarter: { key: quarterKey(), tokens: 20 }, completed: [`v1.0.1:sha256:${"1".padStart(64, "0")}:audience-v1`] });
  await service.drain(Date.now() + 2000, 0, 1);
  expect(synth).toHaveBeenCalledTimes(1);
  expect(judgeAdvisories).toHaveBeenCalled();
  expect(job.quarter).toEqual({ key: quarterKey(), tokens: 30 });
  expect(job.state).toBe("monitoring");
});

test("under a spent budget every slot may take a release check past the cap, and nothing that can call a model starts", async () => {
  const service = new CoverageService(3, { limits: limits({ tokensPerPeriod: 0 }) }).hold();
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const job = (name: string, fields: Partial<Job>) => Object.assign(service.submit(`pkg:npm/${name}`), { admitted: "used", ...fields });
  // Ahead of the checks by demand, and by the oldest read: neither may start.
  job("backlog", { demand: 1000 });
  job("refresh", { state: "monitoring", monitored: old, release_checked: old, retry_at: old, demand: 500 });
  for (const name of ["check-a", "check-b"])
    job(name, { state: "monitoring", monitored: day, release_checked: day, retry_at: day, overflow: quarterKey() });
  const started: string[] = [];
  let running = 0, most = 0;
  vi.spyOn(service as unknown as { work(job: Job): Promise<void> }, "work").mockImplementation(async (j) => {
    started.push(j.purl.slice(8));
    most = Math.max(most, ++running);
    await new Promise((r) => setTimeout(r, 50));
    running--;
    j.retry_at = new Date(Date.now() + 6 * 3600_000).toISOString();
  });
  await service.drain(Date.now() + 1000, 0, 1);
  expect(started.sort()).toEqual(["check-a", "check-b"]);
  // Both at once: the kept slot is not the only one a check may take.
  expect(most).toBe(2);
});

const events = (log: { mock: { calls: unknown[][] } }, name: string) =>
  log.mock.calls.map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : undefined)).filter((e) => e?.event === name);

test("freshness counts the old tail by day and three days, and what cannot get younger now, without changing earlier fields", () => {
  const service = new CoverageService(0, { limits: limits() });
  const at = Date.now();
  const ago = (hours: number) => new Date(at - hours * 3600_000).toISOString();
  const monitored = (name: string, hours: number | undefined, extra: Partial<Job> = {}) => {
    const job = service.submit(`pkg:npm/${name}`);
    Object.assign(job, { state: "monitoring", descriptor: { repo: `ex/${name}` }, ...extra });
    if (hours !== undefined) job.release_checked = ago(hours);
    return job;
  };
  monitored("fresh", 1);
  monitored("day", 30);
  monitored("week", 24 * 7);
  // Failed since its last read, which a slice reaching the read would have renewed: it cannot improve now.
  monitored("failing", 24 * 9, { failures: 3, updated: ago(1) });
  // Failed after its read (the read is within the slice): it is checked, its failure is later.
  monitored("late-failure", 2, { failures: 1, updated: ago(1.9) });
  // Failed after its read, then saved again later (the estimate's false positive): its check is younger than the
  // refresh interval, so it is never counted and stays in the checkable ages.
  monitored("saved-later", 5, { failures: 1, updated: ago(0.5) });
  // No repository: `release_checked` is never set.
  monitored("homepage", undefined, { descriptor: { homepage: "https://example.org" } as never });
  const f = service.freshness(at);
  expect(f).toMatchObject({ monitored: 7, release_check_unknown: 1, release_checks_over_6h: 3,
    release_check_age_s: { max: 24 * 9 * 3600 } });
  expect(f).toMatchObject({ release_checks_over_24h: 3, release_checks_over_3d: 2,
    unimprovable: { no_repository: 1, failing_before_read_estimate: 1 },
    release_check_age_s_checkable: { p95: 24 * 7 * 3600, max: 24 * 7 * 3600 } });
});

test("a yielded check slice of the kept slot logs one line, is counted in kept_slot, and adds nothing to public status", async () => {
  await mockWork({ "pkg:npm/verbose": { repo: "ex/verbose", tags: ["v1.0.3", "v1.0.2", "v1.0.1"], size: 60 } });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const service = new CoverageService(1, { advisories: false, limits: limits({ techQuarterTokens: 100 }), admission: async () => ({ admit: true, why: "test" }) }).hold();
  const job = service.submit("pkg:npm/verbose");
  const day = new Date(Date.now() - 86_400_000).toISOString();
  Object.assign(job, { admitted: "used", monitored: day, refresh_checked: day, overflow: quarterKey(), quarter: { key: quarterKey(), tokens: 200 } });
  await service.drain(Date.now() + 2000, 0, 1);
  const yielded = events(log, "slice_yielded");
  // The check (no model call) yields its history to tier 2; the history slices after it are no check and no kept slot.
  expect(yielded[0]).toEqual({ event: "slice_yielded", job: "pkg:npm/verbose", kind: "other", check: true, kept_slot: true, ms: expect.any(Number) });
  expect(yielded.slice(1).every((e) => !e.check && !e.kept_slot)).toBe(true);
  expect(service.metrics()!.kept_slot).toMatchObject({ started: 1, yielded: 1, finished: 0, failed: 0, due_before: 1, overdue_before: 1,
    oldest_overdue_age_s_before: expect.any(Number), due_after: 0, overdue_after: 0, oldest_overdue_age_s_after: null });
  expect(service.metrics()!.kept_slot.oldest_overdue_age_s_before).toBeGreaterThanOrEqual(86_400);
  // Logging only: public status carries none of it (and no operator-only field).
  for (const s of [service.publicStatus(job), ...service.statuses()])
    for (const k of ["kept_slot", "check", "oldest", "unimprovable", "release_checked", "refresh_checked", "monitored", "failures_before_read"]) expect(s).not.toHaveProperty(k);
});

test("the per-slice timing line marks a check slice and a kept-slot slice", async () => {
  await mockWork({ "pkg:npm/capped": { repo: "ex/capped", tags: ["v1.0.0"] }, "pkg:npm/plain": { repo: "ex/plain", tags: ["v1.0.0"] } });
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const service = new CoverageService(1, { advisories: false, limits: limits(), admission: async () => ({ admit: true, why: "test" }) }).hold();
  const day = new Date(Date.now() - 86_400_000).toISOString();
  const capped = service.submit("pkg:npm/capped");
  Object.assign(capped, { state: "monitoring", admitted: "used", monitored: day, release_checked: day, retry_at: day, overflow: quarterKey(),
    completed: ["v1.0.0:sha256:" + "0".repeat(64) + ":audience-v1"] });
  const plain = service.submit("pkg:npm/plain");
  Object.assign(plain, { admitted: "used", demand: 5 });
  await service.drain(Date.now() + 2000, 0, 1);
  const stages = Object.fromEntries(events(log, "coverage_stages").map((e) => [e.technology, e]));
  expect(stages.capped).toMatchObject({ check: true, kept_slot: true });
  expect(stages.plain).toMatchObject({ check: false, kept_slot: false });
});

test("the day and three-day counts are strictly older than their bound", () => {
  const service = new CoverageService(0, { limits: limits() });
  const at = Date.now();
  for (const [name, s] of [["h12", 12 * 3600], ["h24", 24 * 3600], ["h24s", 24 * 3600 + 1], ["d2", 2 * 86_400], ["d3", 3 * 86_400], ["d3s", 3 * 86_400 + 1]] as const) {
    const job = service.submit(`pkg:npm/${name}`);
    Object.assign(job, { state: "monitoring", release_checked: new Date(at - s * 1000).toISOString() });
  }
  expect(service.freshness(at)).toMatchObject({ release_checks_over_24h: 4, release_checks_over_3d: 1 });
});

type Internals = { running: Set<string>; dueRefreshes(at?: number): { due: number; overdue: number; oldest_overdue_age_s: number | null } };

test("the oldest overdue age is the oldest read past its interval, paused or backing off included, running excluded", () => {
  const service = new CoverageService(0, { limits: limits() });
  const at = Date.now();
  const ago = (hours: number) => new Date(at - hours * 3600_000).toISOString();
  const monitored = (name: string, hours: number, extra: Partial<Job> = {}) => {
    const job = service.submit(`pkg:npm/${name}`);
    Object.assign(job, { state: "monitoring", admitted: "used", release_checked: ago(hours), refresh_checked: ago(hours), retry_at: ago(0.1), ...extra });
    return job;
  };
  monitored("day", 24);
  // The oldest is rate-limited (its 429 paused it): not pickable now, still the age.
  monitored("nine-days", 24 * 9, { paused_until: new Date(at + 60_000).toISOString() });
  monitored("backing-off", 48, { failures: 2, retry_at: new Date(at + 3600_000).toISOString() });
  // Running now: not a candidate, not in the age.
  monitored("running", 24 * 30);
  monitored("fresh", 1, { retry_at: new Date(at + 5 * 3600_000).toISOString() });
  (service as unknown as Internals).running.add("pkg:npm/running");
  expect((service as unknown as Internals).dueRefreshes(at)).toEqual({ due: 1, overdue: 3, oldest_overdue_age_s: 24 * 9 * 3600 });
});

test("kept_slot counts a rate-limited and a failed kept slice", async () => {
  for (const [error, counter] of [[new FetchFailure("http_status", "HTTP 429", 429), "rate_limited"], [new FetchFailure("http_status", "HTTP 500", 500), "failed"]] as const) {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const service = new CoverageService(1, { limits: limits() }).hold();
    const job = service.submit(`pkg:npm/${counter}`);
    const day = new Date(Date.now() - 86_400_000).toISOString();
    Object.assign(job, { state: "monitoring", admitted: "used", release_checked: day, retry_at: day });
    vi.spyOn(service as unknown as { work(job: Job): Promise<void> }, "work").mockRejectedValue(error);
    await service.drain(Date.now() + 200, 0, 1);
    expect(service.metrics()!.kept_slot).toMatchObject({ started: 1, finished: 0, yielded: 0, [counter]: 1, [counter === "failed" ? "rate_limited" : "failed"]: 0 });
    // A 429 leaves the 1-day job overdue (paused, not pickable): its age stays.
    if (counter === "rate_limited") expect(service.metrics()!.kept_slot).toMatchObject({ due_after: 0, overdue_after: 1, oldest_overdue_age_s_after: expect.any(Number) });
    vi.restoreAllMocks();
  }
});

test("a drain adds no persisted job field: a saved job's keys are the Job interface's", async () => {
  await mockWork({ "pkg:npm/verbose": { repo: "ex/verbose", tags: ["v1.0.3", "v1.0.2", "v1.0.1"], size: 60 } });
  vi.spyOn(console, "error").mockImplementation(() => {});
  const service = new CoverageService(1, { advisories: false, limits: limits({ techQuarterTokens: 100 }), admission: async () => ({ admit: true, why: "test" }) }).hold();
  const job = service.submit("pkg:npm/verbose");
  const day = new Date(Date.now() - 86_400_000).toISOString();
  Object.assign(job, { admitted: "used", monitored: day, refresh_checked: day, overflow: quarterKey(), quarter: { key: quarterKey(), tokens: 200 } });
  await service.drain(Date.now() + 2000, 0, 1);
  const saved = Object.keys(JSON.parse(readFileSync(join(dir, "central", "onboarding", "jobs", `${createHash("sha256").update(job.purl).digest("hex")}.json`), "utf8")));
  // Every field of the Job interface (service.ts); a new one fails here until it is added on purpose.
  const known = ["schema", "purl", "technology", "name", "state", "stage", "updated", "retry_at", "descriptor", "records", "releases_done", "releases_total",
    "docs_done", "docs_total", "docs_failed", "enumeration", "failures", "completed", "guides_done", "docs_completed", "docs_checked", "next_task", "admitted",
    "demand", "downloads", "quarter", "overflow", "stream", "merged_into", "siblings", "deprecation_notice", "archived", "lifecycle_checked", "lifecycle_rules",
    "advisories_first", "interrupted", "paused_until", "monitored", "release_checked", "refresh_completed", "registry_polled", "registry_version",
    "registry_checked", "change_detected", "refresh_checked"];
  expect(saved.filter((k) => !known.includes(k))).toEqual([]);
  expect(saved).toEqual(expect.arrayContaining(["release_checked", "refresh_checked"]));
});
