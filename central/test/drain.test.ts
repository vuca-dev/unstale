// Batch mode (`coverage drain`) for an ephemeral runner: requests pulled from the gateway join the saved queue as
// votes, the queue is worked until nothing more can start or the deadline passes, and every job's public status is
// exported beside the catalog so a static host can answer `GET /coverage`.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as discovery from "../src/onboarding/discovery.ts";
import { CoverageService } from "../src/onboarding/service.ts";
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
  expect(r).toEqual({ started: 3, unfinished: 0 });
  for (const j of service.jobs.values()) expect(j.state).toBe("blocked");
});

test("with the budget spent or the deadline passed, drain starts nothing and returns at once", async () => {
  const spy = noSources();
  const spent = new CoverageService(1, { limits: limits({ tokensPerPeriod: 0 }) }).hold();
  spent.submit("pkg:npm/a");
  expect(await spent.drain(Date.now() + 60_000, 1_000, 10)).toEqual({ started: 0, unfinished: 0 });
  const late = new CoverageService(1, { limits: limits() }).hold();
  late.submit("pkg:npm/b");
  expect(await late.drain(Date.now() - 1, 1_000, 10)).toEqual({ started: 0, unfinished: 0 });
  expect(spy).not.toHaveBeenCalled();
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
