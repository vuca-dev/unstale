// Batch mode (`coverage drain`) for an ephemeral runner: requests pulled from the gateway join the saved queue as
// votes, the queue is worked until nothing more can start or the deadline passes, and every job's public status is
// exported beside the catalog so a static host can answer `GET /coverage`.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as discovery from "../src/onboarding/discovery.ts";
import { CoverageService, SLICE_LIMIT_CYCLES, SLICE_LIMIT_MS } from "../src/onboarding/service.ts";
import { Taken } from "../src/onboarding/taken.ts";
import type { Limits } from "../src/onboarding/limits.ts";
import { exportCatalog } from "../src/pipeline/export.ts";
import { catalogDir, centralDir, usageLog } from "../src/pipeline/paths.ts";
import { publishTechnology } from "../src/pipeline/publish.ts";
import { logUsage, sha256 } from "../src/pipeline/util.ts";
import { store } from "./catalog-fixture.ts";

const previous = process.env.UNSTALE_STORE;
beforeEach(() => {
  process.env.UNSTALE_STORE = mkdtempSync(join(tmpdir(), "unstale-drain-"));
});
afterEach(() => {
  if (previous === undefined) delete process.env.UNSTALE_STORE;
  else process.env.UNSTALE_STORE = previous;
  vi.restoreAllMocks();
  vi.useRealTimers();
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

// Discovery that finds no official sources: the job ends blocked without any fetch or model call.
const noSources = () =>
  vi.spyOn(discovery, "discoverTechnology").mockImplementation(async (purl) => ({
    discovery_version: discovery.DISCOVERY_VERSION,
    purl,
    id: discovery.technologyId(purl),
    name: discovery.packageIdentity(purl),
    latest: "1.0.0",
    tag: "^v?(\\d+\\.\\d+\\.\\d+)$",
    components: [purl],
  }));

test("pulled requests are votes on known packages and new jobs otherwise; invalid identities are skipped", () => {
  const service = new CoverageService(0, { limits: limits() });
  service.submit("pkg:npm/known").demand = 2;
  const taken = service.enqueue([
    { purl: "pkg:npm/known", demand: 3 },
    { purl: "pkg:npm/fresh", demand: 5 },
    { purl: "https://example.com/private", demand: 9 },
  ]);
  expect(taken).toEqual(["pkg:npm/known", "pkg:npm/fresh"]);
  expect(service.jobs.get("pkg:npm/known")?.demand).toBe(5);
  expect(service.jobs.get("pkg:npm/fresh")).toMatchObject({ state: "queued", demand: 5 });
  // Persisted: the next run (a new runner) sees the same demand.
  expect(new CoverageService(0, { limits: limits() }).jobs.get("pkg:npm/fresh")?.demand).toBe(5);
});

test("drain works the queue until nothing more can start, then returns", async () => {
  noSources();
  const service = new CoverageService(2, { limits: limits() }).hold();
  service.enqueue(["a", "b", "c"].map((n) => ({ purl: `pkg:npm/${n}`, demand: 1 })));
  const r = await service.drain(Date.now() + 60_000, 5_000, 10);
  expect(r).toEqual({ started: 3, unfinished: 0, drained: true });
  for (const j of service.jobs.values()) expect(j.state).toBe("blocked");
  // The final line's measurements: three new technologies started and settled, nothing rate limited.
  expect(service.metrics()).toMatchObject({ slices: { new: { started: 3, finished: 3, failed: 0, rate_limited: 0 }, refresh: { started: 0 } }, pauses: 0 });
});

test("a failed slice is logged with its technology, kind, failure count and reason, as its status says", async () => {
  vi.spyOn(discovery, "discoverTechnology").mockRejectedValue(new Error("registry answered HTTP 500"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const service = new CoverageService(1, { limits: limits() }).hold();
  service.enqueue([{ purl: "pkg:npm/broken", demand: 1 }]);
  await service.drain(Date.now() + 60_000, 5_000, 10);
  expect(service.metrics()).toMatchObject({ slices: { new: { started: 1, failed: 1 } } });
  const events = log.mock.calls.map(([line]) => (typeof line === "string" && line.startsWith("{") ? JSON.parse(line) : undefined)).filter((e) => e?.event === "slice_failed");
  const job = service.jobs.get("pkg:npm/broken")!;
  expect(events).toEqual([{ event: "slice_failed", technology: job.technology, kind: "new", failures: 1, why: "registry answered HTTP 500" }]);
  expect(job).toMatchObject({ state: "failed", stage: "registry answered HTTP 500" });
});

test("no count of new technologies: a large repository's 400 packages all start in one drain while tokens last", async () => {
  noSources();
  const service = new CoverageService(50, { limits: limits({ runsPerDay: Infinity }) }).hold();
  service.enqueue(Array.from({ length: 400 }, (_, i) => ({ purl: `pkg:npm/p${i}`, demand: 1 })));
  expect(await service.drain(Date.now() + 60_000, 5_000, 10)).toEqual({ started: 400, unfinished: 0, drained: true });
  expect(service.spent()).toEqual([]);
});

test("with the budget spent or the deadline passed, drain starts nothing and returns at once", async () => {
  const spy = noSources();
  const spent = new CoverageService(1, { limits: limits({ tokensPerPeriod: 0 }) }).hold();
  spent.submit("pkg:npm/a");
  // Never an unexplained `started: 0`: the limit that held the queue back, its cap and when it resets.
  // The clock (Date only; timers stay real) is frozen so a run across 00:00 UTC cannot change the day under the test.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-17T14:51:00Z"));
  const tomorrow = "2026-10-18T00:00:00.000Z";
  expect(await spent.drain(Date.now() + 60_000, 1_000, 10)).toEqual({ started: 0, unfinished: 0, drained: true, held: [{ limit: "tokens", cap: 0, resets: tomorrow }] });
  const late = new CoverageService(1, { limits: limits() }).hold();
  late.submit("pkg:npm/b");
  expect(await late.drain(Date.now() - 1, 1_000, 10)).toEqual({ started: 0, unfinished: 0, drained: false });
  expect(spy).not.toHaveBeenCalled();
});

test("a drain held back by the daily run count names it with its cap and reset", async () => {
  noSources();
  // The clock (Date only; timers stay real) is frozen so a run across 00:00 UTC cannot change the day under the test.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-17T14:51:00Z"));
  const tomorrow = "2026-10-18T00:00:00.000Z";
  const fresh = new CoverageService(1, { limits: limits({ runsPerDay: 1 }) }).hold();
  fresh.enqueue(["a", "b"].map((n) => ({ purl: `pkg:npm/${n}`, demand: 1 })));
  expect(await fresh.drain(Date.now() + 60_000, 5_000, 10)).toEqual({ started: 1, unfinished: 0, drained: true, held: [{ limit: "runs_per_day", cap: 1, resets: tomorrow }] });
  expect(fresh.spent()).toEqual([{ limit: "runs_per_day", cap: 1, resets: tomorrow }]);
  // The counter persists, so the next drain the same day is held back by the same limit before starting anything.
  const again = new CoverageService(1, { limits: limits({ runsPerDay: 1 }) }).hold();
  expect(await again.drain(Date.now() + 60_000, 5_000, 10)).toMatchObject({ started: 0, held: [{ limit: "runs_per_day" }] });
});

test("statuses carry the queue position a waiting job would be told", () => {
  const service = new CoverageService(0, { limits: limits() });
  service.submit("pkg:npm/one").demand = 1;
  service.submit("pkg:npm/many").demand = 9;
  const byPurl = Object.fromEntries(service.statuses().map((s) => [s.purl, s]));
  expect(byPurl["pkg:npm/many"]).toMatchObject({ queue_position: 1, queue_length: 2 });
  expect(byPurl["pkg:npm/one"]).toMatchObject({ queue_position: 2, queue_length: 2 });
  expect(JSON.stringify(byPurl)).not.toMatch(/descriptor|admitted|completed/);
});

test("export publishes each status under the hash of its package and refuses a misfiled one", () => {
  publishTechnology(store(), "2026-10-15T06:00:00Z", catalogDir());
  const statuses = join(centralDir(), "onboarding", "status");
  mkdirSync(statuses, { recursive: true });
  const status = { purl: "pkg:npm/next", technology: "next", name: "next", state: "monitoring", stage: "done", records: 2 };
  writeFileSync(join(statuses, `${sha256(status.purl)}.json`), JSON.stringify(status));
  const out = join(mkdtempSync(join(tmpdir(), "unstale-drain-out-")), "site");
  expect(exportCatalog(catalogDir(), out).coverage).toBe(1);
  expect(readdirSync(join(out, "v1", "coverage"))).toEqual([`${sha256(status.purl)}.json`]);
  expect(JSON.parse(readFileSync(join(out, "v1", "coverage", `${sha256(status.purl)}.json`), "utf8"))).toEqual(status);
  writeFileSync(join(statuses, `${sha256("pkg:npm/other")}.json`), JSON.stringify(status));
  expect(() => exportCatalog(catalogDir(), out)).toThrow(/does not name the package/);
});

test("a file in the jobs folder that is not a saved job (macOS ._* metadata) is never read", () => {
  new CoverageService(0, { limits: limits() }).submit("pkg:npm/a");
  const jobs = join(centralDir(), "onboarding", "jobs");
  writeFileSync(join(jobs, `._${sha256("pkg:npm/a")}.json`), Buffer.from("\x00\x05\x16\x07\x00\x02\x00\x00Mac OS X", "latin1"));
  expect([...new CoverageService(0, { limits: limits() }).jobs.keys()]).toEqual(["pkg:npm/a"]);
});

test("usage phase: a new technology's slice is onboarding and a monitored one's refresh is monitoring, at once", async () => {
  // A model call inside each job's work, the two slices interleaving between their calls.
  const answer = noSources().getMockImplementation()!;
  vi.spyOn(discovery, "discoverTechnology").mockImplementation(async (purl) => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, purl.endsWith("new") ? 3 : 2));
      logUsage({ api: "vercel", purl, input_tokens: 1, output_tokens: 1 });
    }
    return answer(purl);
  });
  const service = new CoverageService(2, { limits: limits() }).hold();
  const covered = service.submit("pkg:npm/covered");
  Object.assign(covered, { state: "monitoring", retry_at: "2000-01-01T00:00:00.000Z", admitted: "test", records: 12 });
  service.enqueue([{ purl: "pkg:npm/new", demand: 1 }]);
  await service.drain(Date.now() + 60_000, 5_000, 10);
  const lines = readFileSync(usageLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  const calls = lines.filter((l) => l.api);
  expect(calls.map((l) => l.purl)).not.toEqual([...Array(3).fill(calls[0]!.purl), ...Array(3).fill(calls[3]!.purl)]);
  for (const l of calls) expect(l.phase).toBe(l.purl === "pkg:npm/new" ? "onboarding" : "monitoring");
  expect(new Set(calls.map((l) => l.tech))).toEqual(new Set([covered.technology, service.jobs.get("pkg:npm/new")!.technology]));
  // Neither finished a first coverage (no sources: blocked), so no milestone.
  expect(lines.filter((l) => l.milestone)).toEqual([]);
});

test("a package missing from its registry is parked for a week, not retried as a failure", async () => {
  const { FetchFailure } = await import("../src/collector/http.ts");
  vi.spyOn(discovery, "discoverTechnology").mockRejectedValue(new FetchFailure("http_status", "HTTP 404", 404));
  const service = new CoverageService(1, { limits: limits() }).hold();
  service.enqueue([{ purl: "pkg:npm/gone", demand: 1 }]);
  await service.drain(Date.now() + 60_000, 5_000, 10);
  const job = service.jobs.get("pkg:npm/gone")!;
  expect(job).toMatchObject({ state: "blocked", stage: expect.stringMatching(/^Not found in its public registry/) });
  expect(Date.parse(job.retry_at!) - Date.now()).toBeGreaterThan(6 * 86_400_000);
});

test("a monitored technology whose refresh fails stays monitoring with its records; a new one that fails is failed", async () => {
  const { FetchFailure } = await import("../src/collector/http.ts");
  vi.spyOn(discovery, "discoverTechnology").mockRejectedValue(new FetchFailure("http_status", "HTTP 500", 500));
  const service = new CoverageService(2, { limits: limits() }).hold();
  const covered = service.submit("pkg:npm/covered");
  Object.assign(covered, { state: "monitoring", retry_at: "2000-01-01T00:00:00.000Z", admitted: "test", records: 12 });
  service.enqueue([{ purl: "pkg:npm/new", demand: 1 }]);
  await service.drain(Date.now() + 60_000, 5_000, 10);
  expect(covered).toMatchObject({ state: "monitoring", failures: 1, stage: expect.stringMatching(/^12 verified records; refresh failed \(HTTP 500\), retried after /) });
  expect(Date.parse(covered.retry_at!)).toBeGreaterThan(Date.now());
  expect(service.jobs.get("pkg:npm/new")).toMatchObject({ state: "failed", stage: "HTTP 500", failures: 1 });
});

test("a rate limit counts no failure: the job waits out a pause that holds every start, then the next cycle retries it", async () => {
  const { FetchFailure } = await import("../src/collector/http.ts");
  const spy = vi.spyOn(discovery, "discoverTechnology").mockRejectedValue(new FetchFailure("http_status", "HTTP 429", 429));
  const service = new CoverageService(1, { limits: limits() }).hold();
  const covered = service.submit("pkg:npm/covered");
  Object.assign(covered, { state: "monitoring", retry_at: "2000-01-01T00:00:00.000Z", admitted: "test", records: 12, failures: 0 });
  service.enqueue([{ purl: "pkg:npm/new", demand: 1 }]);
  const r = await service.drain(Date.now() + 300, 1_000, 10);
  // One slot: the first job's 429 pauses every start (a minute at first), so the second is not sent into the same refusal.
  expect(r).toEqual({ started: 1, unfinished: 0, drained: false, rate_limited: 1 });
  expect(spy).toHaveBeenCalledTimes(1);
  expect(covered).toMatchObject({ state: "monitoring", failures: 0, stage: expect.stringMatching(/^12 verified records; refresh rate-limited \(HTTP 429\), retried after /) });
  expect(Date.parse(covered.paused_until!) - Date.now()).toBeGreaterThan(50_000);
  // Paused jobs are not due; a new process (the next cycle) respects the pause it saved.
  const next = new CoverageService(1, { limits: limits() });
  expect(next.queue().map((j) => j.purl)).toEqual(["pkg:npm/new"]);
  expect(next.jobs.get("pkg:npm/covered")).toMatchObject({ failures: 0 });
  expect(next.statuses().find((s) => s.purl === "pkg:npm/covered")).not.toHaveProperty("paused_until");
});

test("a pause that ends before the deadline is waited out in the same drain, longer when the server's Retry-After says so", async () => {
  vi.useFakeTimers();
  const { FetchFailure } = await import("../src/collector/http.ts");
  const answer = noSources().getMockImplementation()!;
  let calls = 0;
  vi.spyOn(discovery, "discoverTechnology").mockImplementation(async (purl) => {
    if (++calls === 1) throw new FetchFailure("http_status", "HTTP 429", 429, 120_000);
    return answer(purl);
  });
  const service = new CoverageService(1, { limits: limits() }).hold();
  service.enqueue([{ purl: "pkg:npm/a", demand: 2 }, { purl: "pkg:npm/b", demand: 1 }]);
  const t0 = Date.now();
  const done = service.drain(t0 + 10 * 60_000, 0, 500);
  await vi.advanceTimersByTimeAsync(100_000);
  // Inside the server's 120 s: the first job is paused and nothing else started.
  expect(service.jobs.get("pkg:npm/a")).toMatchObject({ state: "queued", stage: expect.stringMatching(/^Rate-limited \(HTTP 429\)/) });
  expect(calls).toBe(1);
  await vi.advanceTimersByTimeAsync(30_000);
  const r = await done;
  expect(r).toEqual({ started: 3, unfinished: 0, drained: true });
  expect(Date.now() - t0).toBeLessThan(10 * 60_000);
  expect(service.jobs.get("pkg:npm/a")).toMatchObject({ state: "blocked" });
  expect(service.jobs.get("pkg:npm/a")?.failures).toBeUndefined();
});

test("jobs whose failures were rate limits (the old accounting) are retried at once with their count cleared", () => {
  const jobs = join(centralDir(), "onboarding", "jobs");
  mkdirSync(jobs, { recursive: true });
  const later = new Date(Date.now() + 4 * 3600_000).toISOString();
  const write = (purl: string, fields: object) =>
    writeFileSync(join(jobs, `${sha256(purl)}.json`), JSON.stringify({ schema: 1, purl, technology: purl, name: purl, updated: later, records: 0, releases_done: 0, releases_total: 0, docs_done: 0, docs_total: 0, docs_failed: 0, ...fields }));
  write("pkg:npm/limited", { state: "failed", stage: "HTTP 429", failures: 10, retry_at: later });
  write("pkg:npm/refresh", { state: "monitoring", stage: "3 verified records; refresh failed (https://registry.npmjs.org/x: 429), retried after x", failures: 2, retry_at: later, records: 3, admitted: "t" });
  write("pkg:npm/broken", { state: "failed", stage: "HTTP 500", failures: 4, retry_at: later });
  const service = new CoverageService(0, { limits: limits() });
  expect(service.jobs.get("pkg:npm/limited")).toMatchObject({ state: "queued", stage: "Waiting for a coverage worker", failures: 0 });
  expect(service.jobs.get("pkg:npm/refresh")).toMatchObject({ state: "monitoring", failures: 0 });
  expect(service.jobs.get("pkg:npm/broken")).toMatchObject({ state: "failed", failures: 4, retry_at: later });
  expect(service.queue().map((j) => j.purl).sort()).toEqual(["pkg:npm/limited", "pkg:npm/refresh"]);
});

test("a slice killed with its cycle keeps its work time; past the limit it is stopped with its stage, not resumed first", async () => {
  hanging();
  const service = new CoverageService(2, { limits: limits() }).hold();
  dueRefresh(service, "pkg:npm/refresh");
  service.enqueue([{ purl: "pkg:npm/new", demand: 1 }]);
  expect(await service.drain(Date.now() + 50, 0, 10)).toMatchObject({ started: 2, unfinished: 2, drained: false });
  const next = new CoverageService(2, { limits: limits() });
  for (const purl of ["pkg:npm/refresh", "pkg:npm/new"])
    expect(next.jobs.get(purl)).toMatchObject({ state: "queued", stage: "Resuming interrupted coverage", interrupted: { cycles: 1, stage: "Verifying public registry identity and official sources" } });
  expect(next.jobs.get("pkg:npm/refresh")!.interrupted!.refresh).toBe(true);
  expect(next.statuses().find((s) => s.purl === "pkg:npm/new")).not.toHaveProperty("interrupted");
  // Two full cycles of work without finishing (the limit), as the saved state of a later cycle would hold.
  const jobs = join(centralDir(), "onboarding", "jobs");
  for (const purl of ["pkg:npm/refresh", "pkg:npm/new"]) {
    const file = join(jobs, `${sha256(purl)}.json`);
    const job = JSON.parse(readFileSync(file, "utf8"));
    job.state = "partial";
    job.stage = "Checking security advisories";
    job.interrupted.ms = SLICE_LIMIT_MS;
    job.interrupted.stage = "Checking security advisories";
    job.interrupted.cycles = 2;
    writeFileSync(file, JSON.stringify(job));
  }
  const third = new CoverageService(2, { limits: limits() }).hold();
  const stopped = /"Checking security advisories" did not finish in 40 minutes over 2 cycles; retried after /;
  expect(third.jobs.get("pkg:npm/refresh")).toMatchObject({ state: "monitoring", failures: 1, stage: expect.stringMatching(stopped) });
  expect(third.jobs.get("pkg:npm/new")).toMatchObject({ state: "failed", failures: 1, stage: expect.stringMatching(/^Stopped: /) });
  expect(Date.parse(third.jobs.get("pkg:npm/new")!.retry_at!) - Date.now()).toBeGreaterThan(5 * 3600_000);
  expect(third.jobs.get("pkg:npm/new")).not.toHaveProperty("interrupted");
  expect(third.queue()).toEqual([]);
  expect(await third.drain(Date.now() + 50, 0, 10)).toMatchObject({ started: 0, stopped: 2 });
});

test("a slice found interrupted with no recorded time (a cancelled run) counts a cycle; after SLICE_LIMIT_CYCLES it is stopped", () => {
  const jobs = join(centralDir(), "onboarding", "jobs");
  mkdirSync(jobs, { recursive: true });
  const write = (purl: string, fields: object) =>
    writeFileSync(join(jobs, `${sha256(purl)}.json`), JSON.stringify({ schema: 1, purl, technology: purl, name: purl, updated: "x", records: 4, releases_done: 0, releases_total: 0, docs_done: 0, docs_total: 0, docs_failed: 0, admitted: "t", ...fields }));
  write("pkg:npm/legacy", { state: "partial", stage: "Checking security advisories" });
  write("pkg:npm/crashing", { state: "analyzing", stage: "Reading official release history", interrupted: { ms: 0, cycles: SLICE_LIMIT_CYCLES - 1, stage: "Reading official release history" } });
  const service = new CoverageService(0, { limits: limits() });
  expect(service.jobs.get("pkg:npm/legacy")).toMatchObject({ state: "queued", interrupted: { ms: 0, cycles: 1, stage: "Checking security advisories" } });
  expect(service.jobs.get("pkg:npm/crashing")).toMatchObject({ state: "queued", interrupted: { cycles: SLICE_LIMIT_CYCLES - 1 } });
  // The next process finds it interrupted again, with no drain's end to count it: the cycle it loads at is the limit.
  const file = join(jobs, `${sha256("pkg:npm/crashing")}.json`);
  const job = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(job, { state: "analyzing", interrupted: { ...job.interrupted, cycles: SLICE_LIMIT_CYCLES } });
  writeFileSync(file, JSON.stringify(job));
  expect(new CoverageService(0, { limits: limits() }).jobs.get("pkg:npm/crashing")).toMatchObject({ state: "failed", stage: expect.stringMatching(/^Stopped: "Reading official release history" did not finish in 0 minutes over 4 cycles/) });
});

test("resumed slices never take every slot, even with nothing else waiting when they start", async () => {
  hanging();
  const first = new CoverageService(3, { limits: limits() }).hold();
  for (const n of ["c1", "c2", "c3"]) dueRefresh(first, `pkg:npm/${n}`);
  await first.drain(Date.now() + 50, 0, 10);
  const service = new CoverageService(3, { limits: limits() }).hold();
  const done = service.drain(Date.now() + 300, 0, 10);
  // A new package arrives after the resumed slices took their slots: one slot is still free for it.
  setTimeout(() => service.enqueue([{ purl: "pkg:npm/new", demand: 1 }]), 100);
  expect(await done).toMatchObject({ started: 3, unfinished: 3 });
  const working = [...service.jobs.keys()].filter((p) => service.working(p));
  expect(working).toContain("pkg:npm/new");
  // Two resumed slices ran (now interrupted twice); the third waits for a slot they may hold.
  expect(working.filter((p) => service.jobs.get(p)?.interrupted?.cycles === 2).length).toBe(2);
  expect(service.jobs.get("pkg:npm/new")?.interrupted?.cycles).toBe(1);
});

// Discovery that never answers: a job started stays running, so a test can see which jobs hold the slots.
const hanging = () => vi.spyOn(discovery, "discoverTechnology").mockImplementation(() => new Promise(() => {}));

/** A monitored technology whose refresh is due (tier 0). */
const dueRefresh = (service: CoverageService, purl: string, demand = 5) => {
  const job = service.submit(purl);
  Object.assign(job, { state: "monitoring", retry_at: "2000-01-01T00:00:00.000Z", demand, admitted: "test" });
};

test("a waiting new technology takes one slot in three however much admitted work is due; the line keeps its order", async () => {
  hanging();
  const service = new CoverageService(3, { limits: limits() }).hold();
  expect(service.newSlots).toBe(1);
  for (const n of ["r1", "r2", "r3", "r4"]) dueRefresh(service, `pkg:npm/${n}`);
  service.enqueue([{ purl: "pkg:npm/second", demand: 1 }]);
  service.enqueue([{ purl: "pkg:npm/first", demand: 2 }]);
  const r = await service.drain(Date.now() + 100, 0, 10);
  expect(r).toMatchObject({ started: 3, drained: false });
  const working = [...service.jobs.keys()].filter((p) => service.working(p));
  // Refreshes first in queue order, but one slot goes to the head of the new line (most requested), never the rest.
  expect(working).toEqual(["pkg:npm/r1", "pkg:npm/r2", "pkg:npm/first"]);
});

test("with no new technology waiting, admitted work fills every slot; one slot runs strictly in order", async () => {
  hanging();
  const service = new CoverageService(3, { limits: limits() }).hold();
  for (const n of ["r1", "r2", "r3", "r4"]) dueRefresh(service, `pkg:npm/${n}`);
  await service.drain(Date.now() + 100, 0, 10);
  expect([...service.jobs.keys()].filter((p) => service.working(p))).toEqual(["pkg:npm/r1", "pkg:npm/r2", "pkg:npm/r3"]);
  const one = new CoverageService(1, { limits: limits() });
  expect(one.newSlots).toBe(0);
});

test("a request enqueued after the deadline (a pull during the grace period) is kept for the next cycle, not started", async () => {
  hanging();
  const service = new CoverageService(2, { limits: limits() }).hold();
  service.enqueue([{ purl: "pkg:npm/slow", demand: 1 }]);
  // Well inside the grace period (1 s), so a slow machine cannot reach its end first.
  setTimeout(() => service.enqueue([{ purl: "pkg:npm/late", demand: 1 }]), 150);
  const r = await service.drain(Date.now() + 50, 1_000, 10);
  expect(r).toMatchObject({ started: 1, unfinished: 1, drained: false });
  expect(service.working("pkg:npm/late")).toBe(false);
  expect(service.jobs.get("pkg:npm/late")).toMatchObject({ state: "queued", demand: 1 });
});

test("a drain whose last job finishes in the grace period with nothing left to start is drained", async () => {
  const slow = noSources().getMockImplementation()!;
  vi.spyOn(discovery, "discoverTechnology").mockImplementation(async (purl) => (await new Promise((r) => setTimeout(r, 150)), slow(purl)));
  const service = new CoverageService(1, { limits: limits() }).hold();
  service.enqueue([{ purl: "pkg:npm/one", demand: 1 }]);
  expect(await service.drain(Date.now() + 50, 2_000, 10)).toEqual({ started: 1, unfinished: 0, drained: true });
});

test("pulls during a drain take only what grew since the last one, and the acknowledgement is the whole", () => {
  const taken = new Taken();
  expect(taken.add([{ purl: "pkg:npm/a", demand: 2 }, { purl: "pkg:npm/b", demand: 1 }])).toEqual([{ purl: "pkg:npm/a", demand: 2 }, { purl: "pkg:npm/b", demand: 1 }]);
  // The gateway answers held requests whole until acknowledged: a second pull adds the new vote and the new package only.
  expect(taken.add([{ purl: "pkg:npm/a", demand: 3 }, { purl: "pkg:npm/b", demand: 1 }, { purl: "pkg:npm/c", demand: 1 }])).toEqual([{ purl: "pkg:npm/a", demand: 1 }, { purl: "pkg:npm/c", demand: 1 }]);
  expect(taken.add([{ purl: "pkg:npm/a", demand: 3 }])).toEqual([]);
  expect(taken.size).toBe(3);
  expect(taken.requests()).toEqual([{ purl: "pkg:npm/a", demand: 3 }, { purl: "pkg:npm/b", demand: 1 }, { purl: "pkg:npm/c", demand: 1 }]);
  // Enqueued as deltas, the service counts each requester once.
  const service = new CoverageService(0, { limits: limits() });
  const t = new Taken();
  service.enqueue(t.add([{ purl: "pkg:npm/a", demand: 2 }]));
  service.enqueue(t.add([{ purl: "pkg:npm/a", demand: 3 }]));
  expect(service.jobs.get("pkg:npm/a")?.demand).toBe(3);
});

test("a run reports progress when it changes, and while unchanged only every PROGRESS_HEARTBEAT_MS", async () => {
  const { PROGRESS_HEARTBEAT_MS, progressTicker } = await import("../src/onboarding/progress.ts");
  let now = 0;
  let current = [{ purl: "pkg:npm/a", records: 1 }];
  const sent: unknown[] = [];
  const tick = progressTicker(() => current, async (u) => (sent.push(u), true), () => now);
  await tick();
  now += 5000;
  await tick(); // unchanged: no request
  current = [{ purl: "pkg:npm/a", records: 2 }];
  now += 5000;
  await tick();
  now += PROGRESS_HEARTBEAT_MS - 1;
  await tick(); // unchanged, inside the heartbeat
  now += 1;
  await tick(); // unchanged, the heartbeat: the gateway never calls a followed run silent
  expect(sent).toEqual([[{ purl: "pkg:npm/a", records: 1 }], [{ purl: "pkg:npm/a", records: 2 }], [{ purl: "pkg:npm/a", records: 2 }]]);
});

test("a progress report that was not delivered is sent again at the next tick, not after the heartbeat", async () => {
  const { progressTicker } = await import("../src/onboarding/progress.ts");
  let now = 0;
  let up = false;
  const sent: unknown[] = [];
  const tick = progressTicker(() => [{ purl: "pkg:npm/a", records: 1 }], async (u) => (sent.push(u), up), () => now);
  await tick(); // the gateway is down: not delivered
  now += 5000;
  up = true;
  await tick(); // sent again, delivered
  now += 5000;
  await tick(); // unchanged and delivered: no request
  expect(sent.length).toBe(2);
});

test("a pulled package is reported once its run started it, between slices too, with its save time and when its cycle publishes", async () => {
  const { progressOf } = await import("../src/onboarding/progress.ts");
  const job = (state: string, extra: Record<string, unknown> = {}) =>
    ({ purl: "pkg:pypi/a", technology: "a", name: "a", state, stage: "s", updated: "2026-10-18T15:59:53.037Z", records: 0, releases_done: 0, releases_total: 10, docs_done: 0, docs_total: 0, docs_failed: 0, ...extra }) as never;
  const by = "2026-10-18T16:17:00.000Z";
  const service = (j: unknown, working = false) => ({ jobs: new Map([["pkg:pypi/a", j as never]]), working: () => working });
  // Pulled, not started, and not waiting in the drain's queue (no place given): nothing to report.
  expect(progressOf(service(job("queued")), "pkg:pypi/a", by)).toBeUndefined();
  expect(progressOf(service(job("analyzing"), true), "pkg:pypi/a", by)).toMatchObject({ state: "running", job: { updated: "2026-10-18T15:59:53.037Z", publish_by: by } });
  // Queued again after a slice: still this run's, with what it extracted so far.
  const between = job("queued", { records: 18, releases_done: 3, completed: ["x", "y", "z"], stage: "18 records so far; more history queued" });
  expect(progressOf(service(between), "pkg:pypi/a", by)).toMatchObject({ state: "running", job: { state: "queued", records: 18, releases_done: 3, stage: "18 records so far; more history queued" } });
  expect(progressOf(service(job("partial", { records: 5 })), "pkg:pypi/a", by)).toMatchObject({ state: "publishing", job: { records: 5 } });
  // A merged package shows the job that works it.
  const host = job("analyzing", { purl: "pkg:pypi/host", records: 7 });
  const merged = { jobs: new Map([["pkg:pypi/a", job("queued", { merged_into: "pkg:pypi/host" })], ["pkg:pypi/host", host]]), working: (p: string) => p === "pkg:pypi/host" };
  expect(progressOf(merged, "pkg:pypi/a", by)).toMatchObject({ purl: "pkg:pypi/a", state: "running", job: { records: 7 } });
});

test("an estimate is the place over its line's rate inside the window, and adds a cycle's gap per window it spans", async () => {
  const { startsAt, clockText } = await import("../src/onboarding/eta.ts");
  const min = 60_000;
  const c = { windowEnd: 10 * min, gapMs: 8 * min, windowMs: 15 * min, cycleGapMs: 8 * min };
  // 2 starts a minute: the 10th starts 5 minutes from now, inside the window.
  expect(startsAt(0, 10, 2, c)).toBe(5 * min);
  // The 30th needs 15 minutes of starts: 10 in this window, then the gap, then 5 in the next.
  expect(startsAt(0, 30, 2, c)).toBe((10 + 8 + 5) * min);
  // The 60th: this window (10), the gap, a full window (15) and its gap, then 5 more.
  expect(startsAt(0, 60, 2, c)).toBe((10 + 8 + 15 + 8 + 5) * min);
  // Exactly a window's worth past this one: the last start of the next window, not the start of the one after.
  expect(startsAt(0, 50, 2, c)).toBe((10 + 8 + 15) * min);
  // Asked after the window (a drain's end): the next window starts after the gap.
  expect(startsAt(12 * min, 1, 1, c)).toBe((12 + 8 + 1) * min);
  // No rate measured: no estimate.
  expect(startsAt(0, 1, undefined, c)).toBeUndefined();
  expect(startsAt(0, 1, 0, c)).toBeUndefined();
  expect(clockText(Date.parse("2026-10-18T17:40:00Z"), Date.parse("2026-10-18T17:00:00Z"))).toBe("17:40 UTC");
  expect(clockText(Date.parse("2026-10-19T01:10:00Z"), Date.parse("2026-10-18T17:00:00Z"))).toBe("2026-10-19 01:10 UTC");
});

test("a monitored technology waiting for its refresh takes a place in its line but is shown none", () => {
  const service = new CoverageService(0, { limits: limits() });
  const nx = service.submit("pkg:npm/nx");
  nx.state = "monitoring";
  nx.stage = "639 verified records; documentation coverage partial (702/796 pages)";
  nx.retry_at = new Date(Date.now() - 1000).toISOString();
  const later = service.submit("pkg:npm/later");
  later.admitted = "maintained and used";
  later.completed = ["1.0.0"];
  const byPurl = Object.fromEntries(service.statuses().map((s) => [s.purl, s]));
  expect(byPurl["pkg:npm/nx"]).not.toHaveProperty("queue_position");
  expect(byPurl["pkg:npm/nx"]!.stage).toBe("639 verified records; documentation coverage partial (702/796 pages)");
  expect(byPurl["pkg:npm/later"]).toMatchObject({ queue_position: 2, queue_length: 2 });
  // A failed job due for its retry: the place is the retry's, after the failure it names.
  const failed = service.submit("pkg:npm/failed");
  failed.state = "failed";
  failed.stage = "HTTP 500";
  failed.retry_at = new Date(Date.now() - 1000).toISOString();
  expect(service.publicStatus(failed).stage).toBe("HTTP 500 (retry: position 1 of 1 new technologies)");
});

test("in a drain a waiting job is told when the run reaches it, from its line's rate; without a rate, its place only", async () => {
  // Discovery that does not finish until released: the one slot stays taken, the rest wait.
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  vi.spyOn(discovery, "discoverTechnology").mockImplementation(async (purl) => {
    await held;
    return { discovery_version: discovery.DISCOVERY_VERSION, purl, id: discovery.technologyId(purl), name: discovery.packageIdentity(purl), latest: "1.0.0", tag: "^v?(\\d+\\.\\d+\\.\\d+)$", components: [purl] };
  });
  const service = new CoverageService(1, { limits: limits() }).hold();
  service.enqueue(["a", "b", "c"].map((n, i) => ({ purl: `pkg:npm/${n}`, demand: 3 - i })));
  const drained = service.drain(Date.now() + 15 * 60_000, 5 * 60_000, 10);
  await new Promise((r) => setTimeout(r, 30));
  const before = service.waiting();
  expect(before.get("pkg:npm/b")).toMatchObject({ position: 1, length: 2, stage: "Waiting for a coverage worker (position 1 of 2 new technologies)" });
  expect(before.get("pkg:npm/b")).not.toHaveProperty("starts_at");
  // The last drain measured 1 new technology a minute: c (position 2) starts in about 2 minutes.
  writeFileSync(join(centralDir(), "onboarding", "throughput.json"), JSON.stringify({ rates: { new: 1 } }));
  const now = Date.now();
  const c = service.waiting(now).get("pkg:npm/c")!;
  expect(Date.parse(c.starts_at!)).toBe(now + 2 * 60_000);
  expect(c.stage).toMatch(/^Waiting for a coverage worker \(position 2 of 2 new technologies; a run reaches it at about .+ UTC\)$/);
  // The progress a run reports for a pulled package that waits: its place and estimate, `waiting`.
  const { progressOf } = await import("../src/onboarding/progress.ts");
  expect(progressOf(service, "pkg:npm/c", "2026-10-18T17:00:00.000Z", service.waiting(now))).toMatchObject({
    purl: "pkg:npm/c",
    state: "waiting",
    job: { state: "queued", queue_position: 2, queue_length: 2, starts_at: c.starts_at, stage: c.stage, records: 0 },
  });
  release();
  expect(await drained).toMatchObject({ started: 3, drained: true });
});

test("a waiting package's place is sent with the heartbeat, not with every start; other changes are sent alone", async () => {
  const { PROGRESS_HEARTBEAT_MS, progressKey, progressTicker } = await import("../src/onboarding/progress.ts");
  let now = 0;
  type U = { purl: string; state: "waiting" | "running"; job: Record<string, unknown> };
  let current: U[] = [
    { purl: "pkg:npm/w", state: "waiting", job: { queue_position: 9 } },
    { purl: "pkg:npm/r", state: "running", job: { records: 1 } },
  ];
  const sent: U[][] = [];
  const tick = progressTicker(() => current, async (u) => (sent.push(u), true), () => now, progressKey);
  await tick(); // the first: everything
  current = [{ ...current[0]!, job: { queue_position: 8 } }, current[1]!];
  now += 5000;
  await tick(); // only the place moved: nothing
  current = [current[0]!, { ...current[1]!, job: { records: 2 } }];
  now += 5000;
  await tick(); // the running package alone
  current = [{ ...current[0]!, state: "running", job: { records: 0 } }, current[1]!];
  now += 5000;
  await tick(); // the waiting one started: sent
  now += PROGRESS_HEARTBEAT_MS;
  await tick(); // the heartbeat: everything
  expect(sent.map((u) => u.map((x) => `${x.purl.slice(8)}:${x.state}`))).toEqual([["w:waiting", "r:running"], ["r:running"], ["w:running"], ["w:running", "r:running"]]);
});

test("a request pulled mid-drain joins the drain's queue at its demand position and moves as jobs start", async () => {
  let release: () => void = () => {};
  const held = new Promise<void>((r) => (release = r));
  const order: string[] = [];
  vi.spyOn(discovery, "discoverTechnology").mockImplementation(async (purl) => {
    order.push(purl.slice(8));
    await held;
    return { discovery_version: discovery.DISCOVERY_VERSION, purl, id: discovery.technologyId(purl), name: discovery.packageIdentity(purl), latest: "1.0.0", tag: "^v?(\\d+\\.\\d+\\.\\d+)$", components: [purl] };
  });
  const service = new CoverageService(1, { limits: limits() }).hold();
  service.enqueue(["a", "b", "c"].map((n) => ({ purl: `pkg:npm/${n}`, demand: 1 })));
  const drained = service.drain(Date.now() + 60_000, 5_000, 10);
  await new Promise((r) => setTimeout(r, 30));
  // A pull mid-drain: two requesters, ahead of the waiting single-requester jobs.
  const t = new Taken();
  service.enqueue(t.add([{ purl: "pkg:npm/hot", demand: 2 }]));
  expect(service.waiting().get("pkg:npm/hot")).toMatchObject({ position: 1, length: 3 });
  expect(service.waiting().get("pkg:npm/c")).toMatchObject({ position: 3, length: 3 });
  release();
  await drained;
  expect(order).toEqual(["a", "hot", "b", "c"]);
});

test("token-free first pass: a waiting new technology's advisories are published with the budget spent, no model call, and it keeps its place", async () => {
  const fetching = await import("../src/pipeline/fetch.ts");
  vi.spyOn(discovery, "discoverTechnology").mockImplementation(async (purl) => ({
    discovery_version: discovery.DISCOVERY_VERSION,
    purl,
    id: discovery.technologyId(purl),
    name: discovery.packageIdentity(purl),
    latest: "1.2.0",
    repo: `example/${discovery.packageIdentity(purl)}`,
    tag: "^v?(\\d+\\.\\d+\\.\\d+)$",
    components: [purl],
  }));
  vi.spyOn(fetching, "fetchReleases").mockImplementation(async (t) => ({
    checked: "2026-10-18T00:00:00Z",
    stats: { requests: 1, newReleases: 2 },
    notes: ["1.1.0", "1.2.0"].map((version) => ({
      technology: t.id,
      tag: `v${version}`,
      version,
      date: "2026-09-01",
      url: `https://github.com/example/${t.id}/releases/tag/v${version}`,
      snapshot: "sha256:" + "0".repeat(64),
      notes: "- Fixed things",
    })),
  }));
  const hosts = new Map<string, number>();
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    hosts.set(url.host, (hosts.get(url.host) ?? 0) + 1);
    if (url.host === "api.osv.dev") {
      const purl = (JSON.parse(String(init?.body)) as { package: { purl: string } }).package.purl;
      const name = purl.replace("pkg:npm/", "");
      return new Response(JSON.stringify({ vulns: [{ id: `GHSA-${name.slice(0, 4).padEnd(4, "x")}-aaaa-bbbb`, summary: `Prototype pollution in ${name}`, published: "2026-09-01T00:00:00Z", database_specific: { severity: "HIGH", github_reviewed: true }, affected: [{ package: { ecosystem: "npm", name }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "1.2.0" }] }] }] }] }));
    }
    return new Response("{}", { status: 404 });
  });
  const service = new CoverageService(1, { limits: limits({ tokensPerPeriod: 0 }), admission: async () => ({ admit: true, why: "test" }), advisoriesFirst: 2 }).hold();
  service.enqueue([{ purl: "pkg:npm/alpha", demand: 2 }, { purl: "pkg:npm/beta", demand: 1 }]);
  const r = await service.drain(Date.now() + 10_000, 1_000, 10);
  // The budget held every slice back; the first passes still ran.
  expect(r).toMatchObject({ started: 0, held: [{ limit: "tokens" }] });
  expect([...hosts.keys()].filter((h) => !["api.osv.dev", "registry.npmjs.org"].includes(h))).toEqual([]);
  for (const purl of ["pkg:npm/alpha", "pkg:npm/beta"]) {
    const job = service.jobs.get(purl)!;
    expect(job).toMatchObject({ state: "queued", records: 1 });
    expect(job.advisories_first).toBeDefined();
    // The decision leads: admitted, with the reason, then what the pass published.
    expect(job.stage).toMatch(/^Admitted for coverage \(test\); 1 security advisory record published; release history/);
    // Still new: the line of new technologies keeps its order (demand), not jumped ahead to admitted work.
    expect((service as unknown as { tier: (j: unknown) => number }).tier(job)).toBe(1);
    const index = JSON.parse(readFileSync(join(catalogDir(), "v1", "tech", `${job.technology}.json`), "utf8"));
    expect(index.shards.reduce((n: number, s: { records: number }) => n + s.records, 0)).toBe(1);
  }
  expect(service.queue().map((j) => j.purl)).toEqual(["pkg:npm/alpha", "pkg:npm/beta"]);
  // Nothing reported to the gateway for a job only its first pass touched: its held answer stays, no row written.
  const { progressOf } = await import("../src/onboarding/progress.ts");
  expect(progressOf(service, "pkg:npm/alpha", "2026-10-18T00:00:00Z")).toBeUndefined();
  // Public status: the records, the reason it waits; nothing internal.
  expect(service.statuses().find((s) => s.purl === "pkg:npm/alpha")).not.toHaveProperty("advisories_first");
  // A second drain does not pass them again.
  const osv = hosts.get("api.osv.dev");
  await service.drain(Date.now() + 2_000, 500, 10);
  expect(hosts.get("api.osv.dev")).toBe(osv);
  // Early publish: a drain that pulled a new package ends once it is decided, not at its deadline.
  const { earlyDue } = await import("../src/onboarding/progress.ts");
  service.enqueue([{ purl: "pkg:npm/gamma", demand: 1 }]);
  const fresh = new Set(["pkg:npm/gamma"]);
  expect(earlyDue(service, fresh)).toBe(false);
  expect(earlyDue(service, new Set())).toBe(false);
  const t = Date.now();
  const e = await service.drain(Date.now() + 30_000, 30_000, 10, { due: () => earlyDue(service, fresh), graceMs: 0 });
  expect(e).toMatchObject({ early: true, drained: false });
  expect(Date.now() - t).toBeLessThan(10_000);
  expect(service.jobs.get("pkg:npm/gamma")!.stage).toMatch(/^Admitted for coverage \(test\); 1 security advisory record published/);
});
