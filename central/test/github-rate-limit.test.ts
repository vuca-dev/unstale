// GitHub's rate-limit 403 (primary: `x-ratelimit-remaining: 0`; secondary: `retry-after` or its message) is a rate
// limit like a 429: the release-list reader throws it as one, the drain pauses every start and counts no failure. Any
// other 403 stays a failure. The docs fetcher answers a rate-limited read as 429, which its readers treat as transient.
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DEFAULT_HTTP, FetchFailure, githubRateLimit, HttpClient, MAX_SERVER_WAIT_MS, parseRetryAfter } from "../src/collector/http.ts";
import { httpFetcher } from "../src/docs/fetcher.ts";
import type { RobotsCache } from "../src/docs/robots.ts";
import { rateLimit } from "../src/onboarding/service.ts";
import { fetchReleases, releaseByTag } from "../src/pipeline/fetch.ts";
import type { Technology } from "../src/pipeline/technologies.ts";

const T: Technology = { id: "limited-00000000", name: "limited", repo: "ex/limited", components: ["pkg:npm/limited"], tag: /^v?(\d+\.\d+\.\d+)$/, clean: (b) => b };
const prevDir = process.env.UNSTALE_CENTRAL_DIR;
const prevToken = process.env.GITHUB_TOKEN;
let calls = 0;

beforeEach(() => {
  process.env.UNSTALE_CENTRAL_DIR = mkdtempSync(join(tmpdir(), "unstale-gh-limit-"));
  process.env.GITHUB_TOKEN = "test-token";
  calls = 0;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  if (prevDir === undefined) delete process.env.UNSTALE_CENTRAL_DIR;
  else process.env.UNSTALE_CENTRAL_DIR = prevDir;
  if (prevToken === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = prevToken;
});

/** Every GitHub request answers 403 with these headers and body. */
function forbid(headers: Record<string, string>, body = '{"message":"Resource not accessible by integration"}') {
  vi.stubGlobal("fetch", async () => {
    calls++;
    return new Response(body, { status: 403, headers });
  });
}

/** fetchReleases' error, its retries' waits run on fake timers. */
async function releasesError(): Promise<unknown> {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const failed = fetchReleases(T).then(() => undefined, (e: unknown) => e);
  await vi.advanceTimersByTimeAsync(10_000);
  return failed;
}

describe("GitHub rate-limit 403", () => {
  test("primary: remaining 0 is a rate limit until the reset, thrown at its first answer", async () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    forbid({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }, '{"message":"API rate limit exceeded for installation ID 1."}');
    const e = await releasesError();
    expect(e).toBeInstanceOf(FetchFailure);
    expect(e).toMatchObject({ httpStatus: 403, host: "api.github.com", rateLimited: true, message: "GitHub ex/limited page 1: 403" });
    expect(calls).toBe(1);
    const limited = rateLimit(e);
    expect(limited?.retryAfterMs).toBeGreaterThan(590_000);
    expect(limited?.retryAfterMs).toBeLessThanOrEqual(600_000);
  });

  test("secondary: retry-after, or only the documented message (at least a minute)", async () => {
    forbid({ "retry-after": "120" }, '{"message":"You have exceeded a secondary rate limit."}');
    expect(rateLimit(await releasesError())).toEqual({ retryAfterMs: 120_000 });
    vi.useRealTimers();
    forbid({}, '{"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}');
    expect(rateLimit(await releasesError())).toEqual({ retryAfterMs: 60_000 });
  });

  test("a 403 that is not a rate limit stays a failure, asked once", async () => {
    forbid({ "x-ratelimit-remaining": "4000" });
    const e = await releasesError();
    expect(e).not.toBeInstanceOf(FetchFailure);
    expect(String(e)).toContain("GitHub ex/limited page 1: 403");
    expect(rateLimit(e)).toBeUndefined();
    expect(calls).toBe(1);
  });

  test("a GitHub 429 keeps its Retry-After for the pause", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 429, headers: { "retry-after": "30" } }));
    expect(rateLimit(await releasesError())).toEqual({ retryAfterMs: 30_000 });
  });

  test("the rule: only a 403, by header or the documented message", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(githubRateLimit(403, h({ "x-ratelimit-remaining": "0" }))).toEqual({});
    expect(githubRateLimit(403, h({}), "API rate limit exceeded for 1.2.3.4.")).toEqual({ retryAfterMs: 60_000 });
    expect(githubRateLimit(403, h({ "x-ratelimit-remaining": "12" }), "Must have admin rights to Repository.")).toBeUndefined();
    expect(githubRateLimit(404, h({ "x-ratelimit-remaining": "0" }))).toBeUndefined();
    expect(githubRateLimit(401, h({ "retry-after": "5" }))).toBeUndefined();
  });

  test("the docs fetcher answers a rate-limited read as 429, a plain 403 as 403", async () => {
    const failing = (e: FetchFailure) => ({ get: async () => { throw e; } }) as unknown as HttpClient;
    const robots = { allowed: async () => true } as unknown as RobotsCache;
    const limited = httpFetcher(failing(new FetchFailure("http_status", "HTTP 403 (rate limit)", 403, 60_000, "api.github.com", true)), robots, "t");
    expect((await limited.get("https://api.github.com/repos/ex/limited", "application/json", true)).status).toBe(429);
    const denied = httpFetcher(failing(new FetchFailure("http_status", "HTTP 403", 403, undefined, "api.github.com")), robots, "t");
    expect((await denied.get("https://api.github.com/repos/ex/limited", "application/json", true)).status).toBe(403);
  });

  test("a GitHub 429 is thrown at its first answer too; a 5xx is still tried three times", async () => {
    vi.stubGlobal("fetch", async () => { calls++; return new Response("", { status: 429 }); });
    expect(rateLimit(await releasesError())).toEqual({});
    expect(calls).toBe(1);
    vi.useRealTimers();
    calls = 0;
    vi.stubGlobal("fetch", async () => { calls++; return new Response("", { status: 502 }); });
    expect(rateLimit(await releasesError())).toBeUndefined();
    expect(calls).toBe(3);
  });

  test("a release asked by its tag: a rate-limit 403 pauses, another 403 fails, a 404 is none", async () => {
    forbid({ "x-ratelimit-remaining": "0" });
    const limited = await releaseByTag("ex/limited", "v1.0.0").catch((e: unknown) => e);
    expect(limited).toMatchObject({ rateLimited: true, httpStatus: 403, message: "GitHub ex/limited tag v1.0.0: 403" });
    expect(calls).toBe(1);
    forbid({});
    const denied = await releaseByTag("ex/limited", "v1.0.0").catch((e: unknown) => e);
    expect(rateLimit(denied)).toBeUndefined();
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    expect(await releaseByTag("ex/limited", "v1.0.0")).toBeUndefined();
  });
});

describe("server waits", () => {
  test("Retry-After: seconds or an HTTP date, at most an hour; a negative or fractional number is no wait", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    expect(parseRetryAfter("86400")).toBe(MAX_SERVER_WAIT_MS);
    expect(parseRetryAfter("99999999999999")).toBe(MAX_SERVER_WAIT_MS);
    expect(parseRetryAfter("-5")).toBeUndefined();
    expect(parseRetryAfter("1.5")).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 2 * 3600_000).toUTCString())).toBe(MAX_SERVER_WAIT_MS);
    expect(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT")).toBe(0);
    expect(parseRetryAfter("soon")).toBeUndefined();
  });

  test("a GitHub reset or retry-after far off, or a reset in milliseconds, waits an hour at most", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(githubRateLimit(403, h({ "retry-after": "86400" }))).toEqual({ retryAfterMs: MAX_SERVER_WAIT_MS });
    expect(githubRateLimit(403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Date.now()) }))).toEqual({ retryAfterMs: MAX_SERVER_WAIT_MS });
    expect(githubRateLimit(403, h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "Infinity" }))).toEqual({});
  });

  test("rateLimit keeps a wait it can act on, capped; anything else is no wait", () => {
    const f = (ms: number) => new FetchFailure("http_status", "HTTP 429", 429, ms, "x.example");
    expect(rateLimit(f(1e20))).toEqual({ retryAfterMs: MAX_SERVER_WAIT_MS });
    expect(rateLimit(f(Number.NaN))).toEqual({});
    expect(rateLimit(f(Number.POSITIVE_INFINITY))).toEqual({});
    expect(rateLimit(f(-1))).toEqual({});
  });
});

describe("the HTTP client", () => {
  test("a 403 is read as a GitHub rate limit only from GitHub's API host", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/limited") res.writeHead(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) }).end("{}");
      else if (req.url === "/secondary") res.writeHead(403).end('{"message":"You have exceeded a secondary rate limit."}');
      else res.writeHead(403).end('{"message":"Must have admin rights to Repository."}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const asGitHub = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"], githubHosts: ["127.0.0.1"] });
      const other = new HttpClient({ ...DEFAULT_HTTP, allowHosts: ["127.0.0.1"] });
      const fail = (c: HttpClient, path: string) => c.get(`${base}${path}`, {}).then(() => undefined, (e: FetchFailure) => e);
      expect(await fail(asGitHub, "/limited")).toMatchObject({ httpStatus: 403, rateLimited: true, host: "127.0.0.1" });
      expect((await fail(asGitHub, "/limited"))!.retryAfterMs).toBeGreaterThan(50_000);
      expect(await fail(asGitHub, "/secondary")).toMatchObject({ rateLimited: true, retryAfterMs: 60_000 });
      expect(await fail(asGitHub, "/denied")).toMatchObject({ httpStatus: 403, rateLimited: false });
      // Any other host's 403, whatever its headers, is a 403.
      expect(await fail(other, "/limited")).toMatchObject({ httpStatus: 403, rateLimited: false });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
