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
import { catalogDir, centralDir } from "../src/pipeline/paths.ts";
import { publishTechnology } from "../src/pipeline/publish.ts";
import { sha256 } from "../src/pipeline/util.ts";
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
