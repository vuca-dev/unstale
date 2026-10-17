// The gateway: the coverage service's wire format answered from the exported catalog and a queue that holds new
// packages between coverage runs; votes and address limits in memory only; a run takes what is held and acknowledges
// it after its deploy; early runs within a daily count.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { technologyId } from "../../central/src/onboarding/identity.ts";
import { Coverage, handle, type Env } from "../src/index.ts";
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
