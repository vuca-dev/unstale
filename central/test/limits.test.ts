// Abuse limits on POST /coverage: per-address rate, the daily budget (persisted, fails closed), the trusted proxy
// hop, admission before any crawl, and no client address in anything written.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoverageService, createCoverageServer, timelinePath } from "../src/onboarding/service.ts";
import { AddressLimiter, DailyBudget, limitsFromEnv, type Limits } from "../src/onboarding/limits.ts";
import { admit, THRESHOLDS } from "../src/pipeline/admission.ts";

let dir: string;
const previous = process.env.UNSTALE_STORE;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unstale-limits-"));
  process.env.UNSTALE_STORE = dir;
});
afterEach(() => {
  if (previous === undefined) delete process.env.UNSTALE_STORE;
  else process.env.UNSTALE_STORE = previous;
  vi.restoreAllMocks();
});

const limits = (l: Partial<Limits>): Limits => ({
  perAddressPerHour: 100,
  votesPerAddressPerHour: 1000,
  runsPerDay: 100,
  trustProxy: 0,
  tokensPerPeriod: 1_000_000,
  period: "day",
  techQuarterTokens: 50_000,
  ...l,
});
async function serve(service: CoverageService) {
  const server = createCoverageServer(service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const register = (purl: string, headers: Record<string, string> = {}) =>
    fetch(base + "/coverage", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ purl }) });
  const close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return { register, close };
}

test("environment defaults and overrides; invalid values keep the default", () => {
  const defaults = { tokensPerPeriod: 1_000_000, period: "day", techQuarterTokens: 50_000 };
  expect(limitsFromEnv({})).toEqual({ perAddressPerHour: 250, votesPerAddressPerHour: 1000, runsPerDay: Infinity, trustProxy: 0, ...defaults });
  expect(limitsFromEnv({ UNSTALE_RATE_PER_HOUR: "3", UNSTALE_VOTES_PER_HOUR: "7", UNSTALE_RUNS_PER_DAY: "x", UNSTALE_TRUST_PROXY: "true" })).toEqual({
    perAddressPerHour: 3,
    votesPerAddressPerHour: 7,
    runsPerDay: Infinity,
    trustProxy: 1,
    ...defaults,
  });
  expect(
    limitsFromEnv({ UNSTALE_BUDGET_TOKENS: "500", UNSTALE_BUDGET_PERIOD: "week", UNSTALE_TECH_QUARTER_TOKENS: "10" }),
  ).toMatchObject({ tokensPerPeriod: 500, period: "week", techQuarterTokens: 10 });
  expect(limitsFromEnv({ UNSTALE_BUDGET_PERIOD: "year" }).period).toBe("day");
});

test("a new technology per address is rate limited with Retry-After; a known one never is", async () => {
  const service = new CoverageService(0, { limits: limits({ perAddressPerHour: 2 }) });
  const { register, close } = await serve(service);
  try {
    expect((await register("pkg:npm/a")).status).toBe(202);
    expect((await register("pkg:npm/b")).status).toBe(202);
    const refused = await register("pkg:npm/c");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(3500);
    expect(await refused.json()).toMatchObject({ limit: "address", error: expect.stringContaining("retry later") });
    expect(service.jobs.has("pkg:npm/c")).toBe(false);
    expect((await register("pkg:npm/a")).status).toBe(202);
    // Without a trusted proxy, a forwarded address is the client's own claim and is ignored.
    expect((await register("pkg:npm/d", { "X-Forwarded-For": "203.0.113.9" })).status).toBe(429);
  } finally {
    await close();
    service.stop();
  }
});

test("behind a trusted proxy, the entry the proxy appended is the client", async () => {
  const service = new CoverageService(0, { limits: limits({ perAddressPerHour: 1, trustProxy: 1 }) });
  const { register, close } = await serve(service);
  try {
    expect((await register("pkg:npm/a", { "X-Forwarded-For": "198.51.100.1" })).status).toBe(202);
    expect((await register("pkg:npm/b", { "X-Forwarded-For": "198.51.100.2" })).status).toBe(202);
    // A spoofed leftmost entry does not buy a new bucket.
    expect((await register("pkg:npm/c", { "X-Forwarded-For": "10.9.9.9, 198.51.100.2" })).status).toBe(429);
  } finally {
    await close();
    service.stop();
  }
});

test("over the daily cap of job runs a request is queued, not refused; the cap survives a restart and resets the next UTC day", async () => {
  expect(limitsFromEnv({ UNSTALE_RUNS_PER_DAY: "0" }).runsPerDay).toBe(0);
  const service = new CoverageService(0, { limits: limits({ runsPerDay: 0 }) });
  const { register, close } = await serve(service);
  try {
    expect((await register("pkg:npm/a")).status).toBe(202);
    const queued = await register("pkg:npm/b", {});
    expect(queued.status).toBe(202);
    expect(await queued.json()).toMatchObject({ state: "queued" });
  } finally {
    await close();
    service.stop();
  }
  const budget = new DailyBudget({ runsPerDay: 1 });
  expect(budget.takeRun()).toBeUndefined();
  expect(new DailyBudget({ runsPerDay: 1 }).takeRun()).toMatchObject({ limit: "budget", kind: "runs" });
  expect(budget.takeRun(Date.now() + 86_400_000)).toBeUndefined();
});

test("an unreadable budget refuses (the one limit that fails closed)", () => {
  const path = join(dir, "budget.json");
  writeFileSync(path, "{not json");
  vi.spyOn(console, "error").mockImplementation(() => {});
  expect(new DailyBudget({ runsPerDay: 10 }, path).takeRun()).toMatchObject({ limit: "budget" });
  expect(new DailyBudget({}, path).takeRun()).toMatchObject({ limit: "budget" }); // fails closed without a run cap too
  expect(new DailyBudget({ runsPerDay: 10 }, join(dir, "absent.json")).takeRun()).toBeUndefined();
});

test("the address window slides and the address table is bounded", () => {
  const limiter = new AddressLimiter(1, 2);
  expect(limiter.take("a", 0)).toBeUndefined();
  expect(limiter.take("a", 1000)).toMatchObject({ limit: "address", retryAfter: 3599 });
  expect(limiter.take("a", 3600_001)).toBeUndefined();
  limiter.take("b", 3600_002);
  limiter.take("c", 3600_003); // drops "a", the oldest
  expect(limiter.take("a", 3600_004)).toBeUndefined();
});

test("admission runs before any crawl: a refusal parks the job for a week; unreadable signals admit", async () => {
  const discovery = await import("../src/onboarding/discovery.ts");
  const fetching = await import("../src/pipeline/fetch.ts");
  vi.spyOn(discovery, "discoverTechnology").mockImplementation(async (purl) => ({
    discovery_version: discovery.DISCOVERY_VERSION,
    purl,
    id: purl.slice(8),
    name: purl.slice(8),
    latest: "1.0.0",
    repo: "example/" + purl.slice(8),
    tag: "^v(\\d+\\.\\d+\\.\\d+)$",
    components: [purl],
  }));
  const releases = vi.spyOn(fetching, "fetchReleases").mockRejectedValue(new Error("stop after admission"));
  const service = new CoverageService(1, {
    limits: limits({}),
    admission: async (purl) =>
      purl.endsWith("dormant")
        ? admit({ purl, lastRelease: "2020-01-01T00:00:00Z", downloads: 5 }, THRESHOLDS.npm)
        : admit({ purl }, THRESHOLDS.npm),
  });
  try {
    service.submit("pkg:npm/dormant");
    await vi.waitFor(() => expect(service.status("pkg:npm/dormant")?.state).toBe("blocked"), { timeout: 3000 });
    const parked = service.status("pkg:npm/dormant")!;
    expect(parked.stage).toContain("Not admitted for monitoring: no release in 365 days");
    expect(Date.parse(parked.retry_at!) - Date.now()).toBeGreaterThan(6 * 86_400_000);
    expect(releases).not.toHaveBeenCalled();
    service.submit("pkg:npm/unknown");
    await vi.waitFor(() => expect(service.status("pkg:npm/unknown")?.state).toBe("failed"), { timeout: 3000 });
    expect(releases).toHaveBeenCalledTimes(1);
    expect(service.jobs.get("pkg:npm/unknown")?.admitted).toBe("no readable signal (fails open)");
  } finally {
    service.stop();
  }
});

test("archived repositories that end a package or a line are public on its status, parked or admitted, read again weekly", async () => {
  const discovery = await import("../src/onboarding/discovery.ts");
  const fetching = await import("../src/pipeline/fetch.ts");
  vi.spyOn(discovery, "discoverTechnology").mockImplementation(async (purl) => ({
    discovery_version: discovery.DISCOVERY_VERSION,
    purl,
    id: purl.slice(8),
    name: purl.slice(8),
    latest: "1.0.0",
    repo: "example/" + purl.slice(8),
    tag: "^v(\\d+\\.\\d+\\.\\d+)$",
    components: [purl],
  }));
  vi.spyOn(fetching, "fetchReleases").mockRejectedValue(new Error("stop after admission"));
  let lines = ["example/old-line"];
  const admission = vi.fn(async (purl: string, repo: string | undefined) =>
    purl.endsWith("dormant")
      ? admit({ purl, repo, archived: true, lastRelease: "2020-01-01T00:00:00Z", downloads: 5 }, THRESHOLDS.npm)
      : admit({ purl, repo, archivedLines: lines }, THRESHOLDS.npm),
  );
  const service = new CoverageService(1, { limits: limits({}), admission });
  try {
    service.submit("pkg:npm/dormant");
    await vi.waitFor(() => expect(service.status("pkg:npm/dormant")?.state).toBe("blocked"), { timeout: 3000 });
    expect(service.status("pkg:npm/dormant")!.stage).toBe("Not admitted for monitoring: repository example/dormant is archived; no release in 365 days");
    const parked = service.statuses().find((j) => j.purl === "pkg:npm/dormant")!;
    expect(parked.archived).toEqual(["example/dormant"]);
    expect(parked).not.toHaveProperty("lifecycle_checked");
    service.submit("pkg:npm/moved");
    await vi.waitFor(() => expect(service.status("pkg:npm/moved")?.state).toBe("failed"), { timeout: 3000 });
    const job = service.jobs.get("pkg:npm/moved")!;
    expect(job.archived).toEqual(["example/old-line"]);
    const calls = admission.mock.calls.length;
    // Admitted: not asked again within the week; asked again after it, and an answer with no archive clears it.
    await (service as unknown as { identify(j: unknown, r: boolean, q: boolean): Promise<unknown> }).identify(job, false, true);
    expect(admission.mock.calls.length).toBe(calls);
    job.lifecycle_checked = new Date(Date.now() - 8 * 86_400_000).toISOString();
    lines = [];
    await (service as unknown as { identify(j: unknown, r: boolean, q: boolean): Promise<unknown> }).identify(job, false, true);
    expect(admission.mock.calls.length).toBe(calls + 1);
    expect(job.archived).toBeUndefined();
  } finally {
    service.stop();
  }
});

test("job runs beyond the daily budget wait queued, with the reason in the stage", async () => {
  const service = new CoverageService(1, { limits: limits({ runsPerDay: 0 }), admission: async () => ({ admit: true, why: "test" }) });
  try {
    const job = service.submit("pkg:npm/a");
    expect(job.state).toBe("queued");
    expect(job.stage).toMatch(/^Daily coverage budget reached; continues after \d{4}-\d{2}-\d{2}$/);
  } finally {
    service.stop();
  }
});

test("nothing written holds the client's address", async () => {
  const service = new CoverageService(0, { limits: limits({ trustProxy: 1 }) });
  const { register, close } = await serve(service);
  try {
    expect((await register("pkg:npm/a", { "X-Forwarded-For": "198.51.100.77" })).status).toBe(202);
  } finally {
    await close();
    service.stop();
  }
  mkdirSync(join(dir, "central", "onboarding"), { recursive: true });
  const jobs = join(dir, "central", "onboarding", "jobs");
  const files = [timelinePath(), ...readdirSync(jobs).map((f) => join(jobs, f))];
  const written = files.map((p) => readFileSync(p, "utf8")).join("\n");
  expect(written).not.toContain("198.51.100.77");
  expect(written).not.toContain("127.0.0.1");
  // The vote is persisted as a count only.
  expect(service.jobs.get("pkg:npm/a")?.demand).toBe(1);
});
