// The gateway: the coverage service's wire format answered from the exported catalog and a queue that holds new
// packages between coverage runs; votes and address limits in memory only; a run takes what is held and acknowledges
// it after its deploy; early runs within a daily count.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { technologyId } from "../../central/src/onboarding/identity.ts";
import { Coverage, handle, nextScheduled, type Env } from "../src/index.ts";
import { PendingQueue, settingsFrom, type Settings } from "../src/queue.ts";
import { memorySql } from "./sqlite.ts";

// The public registries: every package exists unless a test says otherwise.
beforeEach(() => vi.stubGlobal("fetch", async () => new Response("{}")));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settings = (s: Partial<Settings> = {}): Settings => ({ ...settingsFrom({}), ...s });
const T = Date.parse("2026-10-17T12:00:00Z");

test("a new package is queued once; repeat requests are votes, one per requester", () => {
  const sql = memorySql();
  const q = new PendingQueue(sql, settings());
  expect(q.request("pkg:npm/a", "198.51.100.1", false, T)).toEqual({ type: "queued", position: 1, length: 1, fastTrack: false });
  q.request("pkg:npm/a", "198.51.100.1", false, T);
  q.request("pkg:npm/a", "198.51.100.2", false, T);
  expect(q.list()).toEqual([{ purl: "pkg:npm/a", demand: 2 }]);
  // Most requested first: b overtakes a with three requesters.
  for (const ip of ["198.51.100.3", "198.51.100.4", "198.51.100.5"]) q.request("pkg:npm/b", ip, false, T);
  expect(q.position("pkg:npm/b")).toEqual({ position: 1, length: 2 });
  // Nothing written names a requester.
  expect(JSON.stringify(sql.db.prepare("SELECT * FROM pending").all())).not.toMatch(/198\.51\.100/);
});

test("new packages are limited per address per hour; votes have their own limit, uncounted over it; the queue is bounded", () => {
  const q = new PendingQueue(memorySql(), settings({ perAddressPerHour: 2, votesPerAddressPerHour: 2, maxPending: 5 }));
  q.request("pkg:npm/a", "198.51.100.1", false, T);
  q.request("pkg:npm/b", "198.51.100.1", false, T);
  expect(q.request("pkg:npm/c", "198.51.100.1", false, T)).toMatchObject({ type: "refused", limit: "address", retryAfter: 3600 });
  // Votes on known packages have their own bucket; over it the answer is the same and the vote is not counted.
  q.request("pkg:npm/k1", "198.51.100.1", true, T);
  q.request("pkg:npm/k2", "198.51.100.1", true, T);
  expect(q.request("pkg:npm/k3", "198.51.100.1", true, T)).toEqual({ type: "voted" });
  expect(q.list().map((r) => r.purl)).toEqual(["pkg:npm/a", "pkg:npm/b", "pkg:npm/k1", "pkg:npm/k2"]);
  // Votes take nothing from the new-package allowance: an address that voted twice still registers.
  q.request("pkg:npm/a", "198.51.100.2", false, T);
  q.request("pkg:npm/b", "198.51.100.2", false, T);
  expect(q.list().find((r) => r.purl === "pkg:npm/a")?.demand).toBe(2);
  expect(q.request("pkg:npm/c", "198.51.100.2", false, T)).toMatchObject({ type: "queued" });
  expect(q.request("pkg:npm/d", "198.51.100.2", false, T)).toMatchObject({ type: "refused", limit: "budget" });
});

test("an IPv6 /64 is one requester; new packages are capped per hour across all addresses", () => {
  const q = new PendingQueue(memorySql(), settings({ perAddressPerHour: 2, newPerHour: 3 }));
  q.request("pkg:npm/a", "2001:db8:1:2::1", false, T);
  q.request("pkg:npm/b", "2001:db8:1:2:ffff::9", false, T);
  expect(q.request("pkg:npm/c", "2001:db8:1:2:0:0:0:3", false, T)).toMatchObject({ type: "refused", limit: "address" });
  q.request("pkg:npm/a", "2001:db8:1:2::77", false, T);
  expect(q.list().find((r) => r.purl === "pkg:npm/a")?.demand).toBe(1);
  q.request("pkg:npm/c", "2001:db8:1:3::1", false, T);
  expect(q.request("pkg:npm/d", "198.51.100.1", false, T)).toMatchObject({ type: "refused", limit: "budget", retryAfter: 3600 });
  expect(q.request("pkg:npm/a", "198.51.100.1", false, T)).toMatchObject({ type: "queued" });
  expect(q.request("pkg:npm/d", "198.51.100.1", false, T + 3600_000)).toMatchObject({ type: "queued" });
});

test("an acknowledged run subtracts what it took; votes that arrived meanwhile stay for the next run", () => {
  const q = new PendingQueue(memorySql(), settings());
  q.request("pkg:npm/a", "198.51.100.1", false, T);
  q.request("pkg:npm/b", "198.51.100.1", false, T);
  const taken = q.list();
  q.request("pkg:npm/b", "198.51.100.2", false, T);
  expect(q.ack(taken)).toBe(1);
  expect(q.list()).toEqual([{ purl: "pkg:npm/b", demand: 1 }]);
});

test("early runs: at most the daily count, spaced by the interval, counted per UTC day", () => {
  const q = new PendingQueue(memorySql(), settings({ fastTrackPerDay: 2, fastTrackIntervalMs: 15 * 60_000 }));
  const fast = (purl: string, at: number) => (q.request(purl, `198.51.100.${at % 250}`, false, at) as { fastTrack: boolean }).fastTrack;
  expect(fast("pkg:npm/a", T)).toBe(true);
  expect(fast("pkg:npm/b", T + 60_000)).toBe(false); // inside the interval
  expect(fast("pkg:npm/c", T + 16 * 60_000)).toBe(true);
  expect(fast("pkg:npm/d", T + 40 * 60_000)).toBe(false); // the day's count is used
  expect(fast("pkg:npm/e", T + 13 * 3600_000)).toBe(true); // the next UTC day
  expect(new PendingQueue(memorySql(), settings()).request("pkg:npm/a", "x", false, T)).toMatchObject({ fastTrack: false });
});

// Rows read are billed per row visited (5 million a day on the free tier), and an init registers hundreds of packages
// and polls each of them on every pass: no registration or status read may cost more as the queue grows.
test("a registration, a vote and a status read each read a bounded number of rows however long the queue", () => {
  const sql = memorySql();
  const q = new PendingQueue(sql, settings({ perAddressPerHour: 1_000_000, newPerHour: 0, fastTrackPerDay: 5, fastTrackIntervalMs: 0 }));
  for (let i = 0; i < 3000; i++) q.request(`pkg:npm/p${i}`, `198.51.${i % 200}.${i % 250}`, i % 3 === 0, T + i);
  const cost = (f: () => unknown) => {
    const before = sql.rowsRead;
    f();
    return sql.rowsRead - before;
  };
  const view = (purl: string) => (q.position(purl), q.run(purl, T), q.typicalSeconds(), q.spentUntil(T));
  // The first request after a wake reads the held rows once.
  const fresh = new PendingQueue(sql, settings({ perAddressPerHour: 1_000_000, newPerHour: 0 }));
  // A vote on a known package does not need them.
  expect(cost(() => fresh.request("pkg:npm/p0", "203.0.113.9", true, T))).toBe(1);
  expect(cost(() => fresh.held("pkg:npm/p1"))).toBeGreaterThanOrEqual(3000);
  expect(cost(() => fresh.held("pkg:npm/p2"))).toBe(0);
  const costs = {
    registration: cost(() => (q.request("pkg:npm/new", "203.0.113.1", false, T), view("pkg:npm/new"))),
    vote: cost(() => (q.request("pkg:npm/p1", "203.0.113.2", false, T), view("pkg:npm/p1"))),
    known: cost(() => q.request("pkg:npm/p0", "203.0.113.3", true, T)),
    status: cost(() => view("pkg:npm/p2")),
    progress: cost(() => q.report([{ purl: "pkg:npm/p2", state: "running" }], T)),
  };
  // Before the line was kept in memory: 9,015, 6,007, 1, 3,004 and 2 rows with 3,000 held.
  for (const [what, rows] of Object.entries(costs)) expect(rows, what).toBeLessThanOrEqual(20);
});

test("the line kept in memory is the table's order through votes, new packages, acknowledgements and a wake", () => {
  const sql = memorySql();
  const s = settings({ perAddressPerHour: 1_000_000, votesPerAddressPerHour: 1_000_000, newPerHour: 0 });
  let q = new PendingQueue(sql, s);
  let seed = 7;
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
  const check = () => {
    const rows = sql.db.prepare("SELECT purl FROM pending WHERE known = 0 ORDER BY demand DESC, first_seen ASC, purl ASC").all() as { purl: string }[];
    rows.forEach((r, i) => expect(q.position(r.purl)).toEqual({ position: i + 1, length: rows.length }));
    expect(q.position("pkg:npm/never")).toBeUndefined();
  };
  for (let step = 0; step < 600; step++) {
    const purl = `pkg:npm/p${rand(80)}`;
    const r = rand(20);
    if (r === 0) q.ack(q.list().filter(() => rand(2) === 0).map((t) => ({ ...t, demand: rand(t.demand + 1) })), T);
    else if (r === 1) q = new PendingQueue(sql, s);
    else q.request(purl, `198.51.100.${rand(250)}`, rand(4) === 0, T + rand(5) * 1000);
    if (step % 25 === 0) check();
  }
  check();
});

// The Worker over a fake runtime: static files from a map, the object called in-process.
function env(files: Record<string, unknown> = {}, extra: Partial<Env> = {}) {
  const waits: Promise<unknown>[] = [];
  const ctx = { storage: { sql: memorySql() }, waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as DurableObjectState;
  const e = {
    DRAIN_TOKEN: "drain-secret",
    GITHUB_REPOSITORY: "owner/repo",
    ASSETS: {
      fetch: async (input: Request | URL) => {
        const path = new URL(input instanceof Request ? input.url : input).pathname;
        return path in files ? new Response(JSON.stringify(files[path])) : new Response("not found", { status: 404 });
      },
    },
    ...extra,
  } as unknown as Env;
  const object = new Coverage(ctx, e);
  e.COVERAGE = { idFromName: () => "global", get: () => object } as unknown as Env["COVERAGE"];
  return { env: e, waits };
}
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://unstale.example/coverage", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": "198.51.100.9", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const get = (path: string, headers: Record<string, string> = {}) => new Request(`https://unstale.example${path}`, { headers });

async function statusPath(purl: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(purl));
  return `/v1/coverage/${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}.json`;
}

test("the client's protocol: health, a new package queued as a job, a known one answered from its published status", async () => {
  const known = { schema: 1, purl: "pkg:npm/next", technology: "next", name: "next", state: "monitoring", stage: "done", records: 12 };
  const { env: e } = env({ [await statusPath("pkg:npm/next")]: known });
  expect(await (await handle(get("/health"), e)).json()).toEqual({ schema: 1, service: "unstale-coverage" });
  const fresh = await handle(post({ purl: "pkg:pypi/requests" }), e);
  expect(fresh.status).toBe(202);
  expect(await fresh.json()).toMatchObject({ purl: "pkg:pypi/requests", technology: technologyId("pkg:pypi/requests"), name: "requests", state: "queued", queue_position: 1 });
  expect(await (await handle(get("/coverage?purl=pkg%3Apypi%2Frequests"), e)).json()).toMatchObject({ state: "queued", stage: "Waiting for the next coverage run (position 1 of 1)" });
  const vote = await handle(post({ purl: "pkg:npm/next" }), e);
  expect([vote.status, await vote.json()]).toEqual([202, known]);
  expect(await (await handle(get("/coverage?purl=pkg%3Anpm%2Fnext"), e)).json()).toEqual(known);
  expect((await handle(get("/coverage?purl=pkg%3Anpm%2Fnever"), e)).status).toBe(404);
});

test("only one public identity is accepted, never from a browser", async () => {
  const { env: e } = env();
  expect((await handle(post({ purl: "pkg:npm/a" }, { "Content-Type": "text/plain" }), e)).status).toBe(415);
  expect((await handle(post({ purl: "pkg:npm/a" }, { Origin: "https://evil.example" }), e)).status).toBe(403);
  expect((await handle(post("x".repeat(600)), e)).status).toBe(413);
  expect((await handle(post({ purl: "pkg:npm/a", repo: "acme/private" }), e)).status).toBe(400);
  expect((await handle(post({ purl: "pkg:npm/a@1.0.0" }), e)).status).toBe(400);
  expect((await handle(post({ purl: "https://example.com/x" }), e)).status).toBe(400);
});

test("storage that fails (a used-up daily allowance) is a temporary 503 with Retry-After, never a 400", async () => {
  const { env: e } = env();
  const quota = new Error("Exceeded allowed rows read in Durable Objects free tier.");
  e.COVERAGE = { idFromName: () => "global", get: () => new Proxy({}, { get: () => () => Promise.reject(quota) }) } as unknown as Env["COVERAGE"];
  // A fixed clock, away from midnight, so the expected reset cannot move during the test.
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = Date.parse("2026-10-17T16:40:00Z");
  vi.setSystemTime(now);
  for (const r of [post({ purl: "pkg:npm/a" }), get("/coverage?purl=pkg%3Anpm%2Fa")]) {
    const res = await handle(r, e);
    expect(res.status).toBe(503);
    // Until the allowance resets at 00:00 UTC.
    const after = Number(res.headers.get("Retry-After"));
    expect(after).toBe(7 * 3600 + 20 * 60);
    expect(await res.json()).toMatchObject({ retry_after: after });
  }
  e.COVERAGE = { idFromName: () => "global", get: () => new Proxy({}, { get: () => () => Promise.reject(new Error("Durable Object reset")) }) } as unknown as Env["COVERAGE"];
  const other = await handle(post({ purl: "pkg:npm/a" }), e);
  expect([other.status, other.headers.get("Retry-After")]).toEqual([503, "60"]);
  // Bad input is still the client's.
  expect((await handle(post({ purl: "pkg:npm/a@1.0.0" }), e)).status).toBe(400);
  expect((await handle(get("/coverage?purl=nonsense"), e)).status).toBe(400);
  const ack = new Request("https://unstale.example/internal/ack", { method: "POST", headers: { Authorization: "Bearer drain-secret" }, body: "null" });
  expect((await handle(ack, e)).status).toBe(400);
  vi.useRealTimers();
});

test("a name the public registry does not know is not queued", async () => {
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => (asked.push(url), new Response("not found", { status: url.includes("made-up") ? 404 : 200 })));
  const { env: e } = env();
  expect((await handle(post({ purl: "pkg:npm/made-up-name" }), e)).status).toBe(404);
  expect((await handle(post({ purl: "pkg:npm/%40scope/real" }), e)).status).toBe(202);
  expect(asked).toEqual(["https://registry.npmjs.org/made-up-name/latest", "https://registry.npmjs.org/@scope%2Freal/latest"]);
  const auth = { Authorization: "Bearer drain-secret" };
  expect(await (await handle(get("/internal/queue", auth), e)).json()).toEqual({ requests: [{ purl: "pkg:npm/%40scope/real", demand: 1 }] });
});

test("a refused registration is a 429 with Retry-After, as the coverage service answers", async () => {
  const { env: e } = env({}, { RATE_PER_HOUR: "1" });
  await handle(post({ purl: "pkg:npm/a" }), e);
  const r = await handle(post({ purl: "pkg:npm/b" }), e);
  expect(r.status).toBe(429);
  expect(r.headers.get("Retry-After")).toBe("3600");
  expect(await r.json()).toMatchObject({ limit: "address", retry_after: 3600 });
});

test("a coverage run reads and acknowledges the queue with the drain token only", async () => {
  const { env: e } = env();
  await handle(post({ purl: "pkg:npm/a" }), e);
  expect((await handle(get("/internal/queue"), e)).status).toBe(401);
  expect((await handle(get("/internal/queue", { Authorization: "Bearer wrong-secre" }), e)).status).toBe(401);
  const auth = { Authorization: "Bearer drain-secret" };
  const { requests } = (await (await handle(get("/internal/queue", auth), e)).json()) as { requests: unknown[] };
  expect(requests).toEqual([{ purl: "pkg:npm/a", demand: 1 }]);
  const ack = new Request("https://unstale.example/internal/ack", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ requests }) });
  expect(await (await handle(ack, e)).json()).toEqual({ removed: 1 });
  expect((await handle(get("/coverage?purl=pkg%3Anpm%2Fa"), e)).status).toBe(404);
});

test("everything else is the static catalog", async () => {
  const { env: e } = env({ "/v1/root.json": { schema: 1, min_client: "0.1.0" } });
  expect(await (await handle(get("/v1/root.json"), e)).json()).toEqual({ schema: 1, min_client: "0.1.0" });
  expect((await handle(get("/v1/tech/missing.json"), e)).status).toBe(404);
});

test("a fast-tracked package starts the coverage workflow; without a token nothing is sent", async () => {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (url.startsWith("https://api.github.com/")) calls.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(null, { status: 204 });
  });
  const off = env({}, { FAST_TRACK_PER_DAY: "1" });
  await handle(post({ purl: "pkg:npm/a" }), off.env);
  await Promise.all(off.waits);
  expect(calls).toEqual([]);
  const on = env({}, { FAST_TRACK_PER_DAY: "1", GITHUB_DISPATCH_TOKEN: "t" });
  const r = await handle(post({ purl: "pkg:npm/a" }), on.env);
  expect(await r.json()).toMatchObject({ stage: "Queued (position 1 of 1); a coverage run is starting and takes it if it is next" });
  await Promise.all(on.waits);
  expect(calls).toEqual([{ url: "https://api.github.com/repos/owner/repo/actions/workflows/ingest.yml/dispatches", body: { ref: "main", inputs: { reason: "fast-track" } } }]);
});

test("a run's progress on a held package: started early, working, publishing, then its published status", async () => {
  vi.stubGlobal("fetch", async () => new Response(null, { status: 204 }));
  const files: Record<string, unknown> = {};
  const { env: e, waits } = env(files, { FAST_TRACK_PER_DAY: "1", GITHUB_DISPATCH_TOKEN: "t" });
  await handle(post({ purl: "pkg:npm/a" }), e);
  await Promise.all(waits);
  const status = async () => (await (await handle(get("/coverage?purl=pkg%3Anpm%2Fa"), e)).json()) as Record<string, any>;
  expect(await status()).toMatchObject({ state: "queued", run: { state: "dispatched" } });
  const auth = { Authorization: "Bearer drain-secret", "Content-Type": "application/json" };
  const progress = (updates: unknown) => handle(new Request("https://unstale.example/internal/progress", { method: "POST", headers: auth, body: JSON.stringify({ updates }) }), e);
  expect((await handle(new Request("https://unstale.example/internal/progress", { method: "POST", body: "{}" }), e)).status).toBe(401);
  const job = { state: "analyzing", stage: "Reading release notes\u001b[2J", records: 3, releases_done: 2, releases_total: 9, docs_done: 1, docs_total: 4, extra: "x" };
  expect(await (await progress([{ purl: "pkg:npm/a", state: "running", job }, { purl: "pkg:npm/never-held", state: "running" }])).json()).toEqual({ reported: 1 });
  expect(await status()).toMatchObject({ state: "analyzing", stage: "Reading release notes [2J", records: 3, releases_done: 2, releases_total: 9, docs_done: 1, docs_total: 4, run: { state: "running" } });
  await progress([{ purl: "pkg:npm/a", state: "publishing" }]);
  // The last counters stay while the catalog is published.
  expect(await status()).toMatchObject({ state: "analyzing", records: 3, run: { state: "publishing" } });
  files[await statusPath("pkg:npm/a")] = { schema: 1, purl: "pkg:npm/a", technology: "a", name: "a", state: "partial", stage: "done", records: 5 };
  expect(await status()).toEqual(files[await statusPath("pkg:npm/a")]);
  const ack = new Request("https://unstale.example/internal/ack", { method: "POST", headers: auth, body: JSON.stringify({ requests: [{ purl: "pkg:npm/a", demand: 1 }] }) });
  await handle(ack, e);
  delete files[await statusPath("pkg:npm/a")];
  expect((await handle(get("/coverage?purl=pkg%3Anpm%2Fa"), e)).status).toBe(404);
});

test("a declined, failed or silent run is not shown as working the package", () => {
  const q = new PendingQueue(memorySql(), settings({ fastTrackPerDay: 5, fastTrackIntervalMs: 0 }));
  q.request("pkg:npm/a", "198.51.100.1", false, T);
  expect(q.run("pkg:npm/a", T)).toMatchObject({ state: "dispatched", since: T });
  q.report([{ purl: "pkg:npm/a", state: "declined" }], T + 60_000);
  expect(q.run("pkg:npm/a", T + 60_000)).toMatchObject({ state: "declined", since: T });
  q.request("pkg:npm/b", "198.51.100.2", false, T);
  q.undispatched("pkg:npm/b");
  expect(q.run("pkg:npm/b", T)).toBeUndefined();
  q.request("pkg:npm/c", "198.51.100.3", false, T);
  q.report([{ purl: "pkg:npm/c", state: "running" }], T);
  expect(q.run("pkg:npm/c", T + 29 * 60_000)).toBeDefined();
  expect(q.run("pkg:npm/c", T + 31 * 60_000)).toBeUndefined();
  // The time from request to acknowledgement of finished runs only.
  q.report([{ purl: "pkg:npm/c", state: "publishing" }], T + 60_000);
  q.ack([{ purl: "pkg:npm/a", demand: 1 }, { purl: "pkg:npm/c", demand: 1 }], T + 90_000);
  expect(q.typicalSeconds()).toBe(90);
  expect(q.run("pkg:npm/c", T + 90_000)).toBeUndefined();
  // Votes that arrived during the run keep the package held, but its run is over.
  q.request("pkg:npm/d", "198.51.100.4", false, T);
  q.report([{ purl: "pkg:npm/d", state: "publishing" }], T);
  q.request("pkg:npm/d", "198.51.100.5", false, T);
  q.ack([{ purl: "pkg:npm/d", demand: 1 }], T + 30_000);
  expect(q.held("pkg:npm/d")).toBe(true);
  expect(q.run("pkg:npm/d", T + 30_000)).toBeUndefined();
  expect(q.typicalSeconds()).toBe(90);
});

test("while central's budget is spent a new package is queued as always but starts no early run; after the reset it does", () => {
  const q = new PendingQueue(memorySql(), settings({ fastTrackPerDay: 2, fastTrackIntervalMs: 0 }));
  const reset = Date.parse("2026-10-18T00:00:00Z");
  q.setBudget(reset);
  expect(q.spentUntil(T)).toBe(reset);
  expect(q.request("pkg:npm/a", "198.51.100.1", false, T)).toEqual({ type: "queued", position: 1, length: 1, fastTrack: false });
  expect(q.run("pkg:npm/a", T)).toBeUndefined();
  // The skipped early run does not use up the day's count.
  expect(q.spentUntil(reset)).toBeUndefined();
  expect(q.request("pkg:npm/b", "198.51.100.2", false, reset)).toMatchObject({ type: "queued", fastTrack: true });
  expect(q.request("pkg:npm/c", "198.51.100.3", false, reset)).toMatchObject({ type: "queued", fastTrack: true });
  // A run that reports the budget not spent (raised, or reset) clears it at once.
  q.setBudget(reset + 86_400_000);
  q.setBudget(undefined);
  expect(q.spentUntil(reset)).toBeUndefined();
});

test("a run reports the budget with its progress; the gateway dispatches nothing while it is spent and says why", async () => {
  const dispatches: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("https://api.github.com/")) dispatches.push(url);
    return new Response(null, { status: 204 });
  });
  const { env: e, waits } = env({}, { FAST_TRACK_PER_DAY: "5", FAST_TRACK_INTERVAL_MINUTES: "0", GITHUB_DISPATCH_TOKEN: "t" });
  const auth = { Authorization: "Bearer drain-secret", "Content-Type": "application/json" };
  const progress = (body: unknown) => handle(new Request("https://unstale.example/internal/progress", { method: "POST", headers: auth, body: JSON.stringify(body) }), e);
  const until = new Date(Date.now() + 3 * 3600_000);
  for (const bad of ["soon", "0", "2026-10-18"]) expect((await progress({ updates: [], budget: { spent_until: bad } })).status).toBe(400);
  expect(await (await progress({ updates: [], budget: { spent_until: until.toISOString() } })).json()).toEqual({ reported: 0 });
  const r = await handle(post({ purl: "pkg:npm/a" }), e);
  expect(r.status).toBe(202);
  const body = (await r.json()) as Record<string, string>;
  expect(body.stage).toMatch(/^Waiting for the coverage budget, spent until \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(position 1 of 1\); the next run that can take it is at \d{2}:\d{2} UTC$/);
  expect(Date.parse(body.next_run!)).toBeGreaterThan(until.getTime());
  await Promise.all(waits);
  expect(dispatches).toEqual([]);
  // A report without the field leaves it; one with null clears it.
  await progress({ updates: [] });
  await handle(post({ purl: "pkg:npm/b" }, { "CF-Connecting-IP": "198.51.100.10" }), e);
  await Promise.all(waits);
  expect(dispatches).toEqual([]);
  await progress({ updates: [], budget: { spent_until: null } });
  await handle(post({ purl: "pkg:npm/c" }, { "CF-Connecting-IP": "198.51.100.11" }), e);
  await Promise.all(waits);
  expect(dispatches).toHaveLength(1);
});

test("a failed or unreachable dispatch leaves the package waiting for the schedule; the next scheduled run is named", async () => {
  vi.stubGlobal("fetch", async (url: string) => {
    if (url.startsWith("https://api.github.com/") && failure === "network") throw new TypeError("fetch failed");
    return new Response(null, { status: url.startsWith("https://api.github.com/") ? 401 : 200 });
  });
  let failure = "status";
  const { env: e, waits } = env({}, { FAST_TRACK_PER_DAY: "2", FAST_TRACK_INTERVAL_MINUTES: "0", GITHUB_DISPATCH_TOKEN: "t" });
  await handle(post({ purl: "pkg:npm/a" }), e);
  failure = "network";
  await handle(post({ purl: "pkg:npm/b" }, { "CF-Connecting-IP": "198.51.100.10" }), e);
  await Promise.all(waits);
  const body = (await (await handle(get("/coverage?purl=pkg%3Anpm%2Fa"), e)).json()) as Record<string, unknown>;
  expect(body.run).toBeUndefined();
  expect(((await (await handle(get("/coverage?purl=pkg%3Anpm%2Fb"), e)).json()) as Record<string, unknown>).run).toBeUndefined();
  expect(Date.parse(String(body.next_run))).toBeGreaterThan(Date.now());
  expect(nextScheduled(Date.parse("2026-10-17T12:00:00Z")).toISOString()).toBe("2026-10-17T12:23:00.000Z");
  expect(nextScheduled(Date.parse("2026-10-17T12:23:00Z")).toISOString()).toBe("2026-10-17T15:23:00.000Z");
  expect(nextScheduled(Date.parse("2026-10-17T22:50:00Z")).toISOString()).toBe("2026-10-18T00:23:00.000Z");
});
